import fs from 'node:fs';
import path from 'node:path';
import { readText } from './util.js';

/**
 * Machine-local settings of a repo live in `<repo>/.pf/`, never in a committed file: what one checkout
 * pushes to, for example, is not what another machine does. `pf repo` adds `.pf/` to the repo's
 * `.gitignore`, and writing here also drops a `.pf/.gitignore` of `*`, so the folder is never committed.
 */

export const LOCAL_DIR = '.pf';
export const LOCAL_CONFIG = 'config.json';

/** A git remote name pf accepts: letters, digits, `.`, `_`, `-`, never a leading dash or dot (it ends up in an argv; `.` would be the local repo). */
export const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export interface GitPushConfig {
  /** The remote `pf gp` pushes to first. Unset: the branch's upstream remote, else `origin`. */
  primary?: string;
  /** Remotes that receive the same push after the primary. */
  secondary?: string[];
}

export interface LocalConfig {
  git?: { push?: GitPushConfig };
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function localDir(root: string): string {
  return path.join(root, LOCAL_DIR);
}

export function localConfigPath(root: string): string {
  return path.join(localDir(root), LOCAL_CONFIG);
}

/** Keep only well-formed fields of the `git.push` block. */
export function parseGitPush(v: unknown): GitPushConfig {
  if (!isObj(v)) return {};
  const primary = typeof v.primary === 'string' && REMOTE_NAME.test(v.primary.trim()) ? v.primary.trim() : undefined;
  const list = Array.isArray(v.secondary) ? v.secondary : [];
  const secondary: string[] = [];
  for (const s of list) {
    if (typeof s !== 'string') continue;
    const n = s.trim();
    if (REMOTE_NAME.test(n) && !secondary.includes(n) && n !== primary) secondary.push(n);
  }
  return { ...(primary ? { primary } : {}), ...(secondary.length ? { secondary } : {}) };
}

/** Read `.pf/config.json`. A missing or invalid file reads as an empty config. */
export function loadLocalConfig(root: string): LocalConfig {
  const text = readText(localConfigPath(root));
  if (text === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isObj(raw) || !isObj(raw.git)) return {};
  const push = parseGitPush(raw.git.push);
  return Object.keys(push).length ? { git: { push } } : {};
}

export type LocalWrite = { ok: true; changed: boolean } | { ok: false; error: string };

/**
 * Merge `values` into an object section of `.pf/config.json` (a value of `undefined` removes the key), creating
 * the folder, its `.gitignore` and the file as needed. Other keys are kept. A file that is not a JSON object (or
 * a section that is not an object) is never overwritten. With `dryRun` nothing is written.
 */
export function setLocalConfigSection(root: string, section: string, values: Record<string, unknown>, opts: { dryRun?: boolean } = {}): LocalWrite {
  const file = localConfigPath(root);
  const text = readText(file);
  let doc: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObj(parsed)) return { ok: false, error: `${LOCAL_DIR}/${LOCAL_CONFIG} is not a JSON object` };
      doc = parsed;
    } catch {
      return { ok: false, error: `${LOCAL_DIR}/${LOCAL_CONFIG} is not valid JSON` };
    }
  }
  const current = doc[section];
  if (current !== undefined && !isObj(current)) return { ok: false, error: `"${section}" in ${LOCAL_DIR}/${LOCAL_CONFIG} is not an object` };
  const next = { ...(current ?? {}) } as Record<string, unknown>;
  let changed = false;
  for (const [k, v] of Object.entries(values)) {
    if (k === '__proto__') continue;
    if (v === undefined) {
      if (k in next) {
        delete next[k];
        changed = true;
      }
    } else if (JSON.stringify(next[k]) !== JSON.stringify(v)) {
      next[k] = v;
      changed = true;
    }
  }
  if (!changed) return { ok: true, changed: false };
  if (opts.dryRun) return { ok: true, changed: true };
  if (Object.keys(next).length) doc[section] = next;
  else delete doc[section];
  try {
    fs.mkdirSync(localDir(root), { recursive: true });
    const guard = path.join(localDir(root), '.gitignore');
    if (!fs.existsSync(guard)) fs.writeFileSync(guard, '*\n');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, error: `could not write ${LOCAL_DIR}/${LOCAL_CONFIG}: ${(e as Error).message}` };
  }
}

/** Is `.pf` (or `.pf/`, `/.pf`, `/.pf/`) already a line of a .gitignore text? */
export function ignoresLocalDir(gitignore: string): boolean {
  return gitignore.split(/\r?\n/).some((l) => /^\/?\.pf\/?$/.test(l.trim()));
}

export type IgnoreResult = { ok: true; changed: boolean; message: string } | { ok: false; error: string };

/**
 * Put `.pf/` in the repo's `.gitignore` (created when missing). Idempotent. Without the repo's own `.git` it does
 * nothing, so a plain folder or a parent repo's ignore file is never touched.
 */
export function ensureLocalIgnored(root: string, opts: { dryRun?: boolean } = {}): IgnoreResult {
  if (!fs.existsSync(path.join(root, '.git'))) return { ok: true, changed: false, message: `${LOCAL_DIR}/: not a git checkout, .gitignore left alone` };
  const file = path.join(root, '.gitignore');
  const text = readText(file);
  if (text !== null && ignoresLocalDir(text)) return { ok: true, changed: false, message: `${LOCAL_DIR}/ is already in .gitignore` };
  const verb = text === null ? 'create .gitignore with' : 'add';
  if (opts.dryRun) return { ok: true, changed: true, message: `would ${verb} ${LOCAL_DIR}/ (machine-local pf settings) in .gitignore` };
  try {
    const sep = text === null || text === '' || text.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(file, `${text ?? ''}${sep}${LOCAL_DIR}/\n`);
  } catch (e) {
    return { ok: false, error: `could not write .gitignore: ${(e as Error).message}` };
  }
  return { ok: true, changed: true, message: `${text === null ? 'created .gitignore with' : 'added'} ${LOCAL_DIR}/ (machine-local pf settings) in .gitignore` };
}
