import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeHomeFile, type RepoConfig } from './config.js';
import { pfHome } from './constants.js';
import { capture } from './exec.js';
import { listDir, readJson } from './util.js';

/**
 * pf remembers a repo in two places. The repo's `pf.json` carries an `id`, and `~/.pf/repos/<id>.json`
 * holds what stays out of the repo: the checkouts pf has seen, the origin remote and private settings.
 * The id ties the two together, so the record survives a moved checkout or a changed remote.
 * `pf repo` (`pf rp`) writes and refreshes both.
 */

/** Raised when the record format or the rules for linking change; older records read as stale until `pf rp` runs again. */
export const REPO_LINK_REVISION = 1;

/** A pf.json `id`. Also the record's file name, so nothing outside this shape is ever used as a path. */
export const REPO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_PATHS = 10;

export interface RepoRecord {
  id: string;
  name: string;
  /** Checkouts linked to this id, most recent first. */
  paths: string[];
  /** Origin remote without credentials or scheme (`github.com/org/repo`). */
  remote?: string;
  /** REPO_LINK_REVISION of the pf that wrote it. */
  revision: number;
  linkedAt: string;
  updatedAt: string;
  /** Per-repo settings kept out of the repo (security-related ones). Only read for a trusted link. */
  settings: Record<string, unknown>;
}

export type LinkState = 'linked' | 'stale' | 'foreign' | 'unlinked';

export interface RepoLink {
  /**
   * `linked`: pf.json and the record agree. `stale`: same repo, but the path, remote, name or link revision
   * changed. `foreign`: pf.json names a record that knows neither this path nor this remote (a copy, or a
   * pf.json taken from another repo); pf rp asks before linking it. `unlinked`: no id, or no record for it.
   */
  state: LinkState;
  /** The pf.json id, else the id of a record found for this path or remote. */
  id: string | null;
  record: RepoRecord | null;
  /** What `pf rp` would refresh, in plain words. Empty when linked. */
  reasons: string[];
}

export function reposDir(): string {
  return path.join(pfHome(), 'repos');
}

/** Normalize a remote URL: no scheme, no user or token, no `.git`. `git@host:org/repo.git` becomes `host/org/repo`. */
export function normalizeRemote(url: string): string | undefined {
  const u = url.trim();
  if (!u) return undefined;
  if (/^[./~]/.test(u)) return u.replace(/\.git$/, '').replace(/\/+$/, '') || undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);
  let out: string;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) out = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const p = new URL(u);
      out = `${p.hostname}${p.port ? `:${p.port}` : ''}${p.pathname}`;
    } catch {
      return undefined;
    }
  }
  return out.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase() || undefined;
}

/** The repo's origin remote, normalized. Undefined without its own `.git` (never a parent repo's remote) or an origin. */
export function repoRemote(root: string): string | undefined {
  if (!fs.existsSync(path.join(root, '.git'))) return undefined;
  const r = capture(['git', 'remote', 'get-url', 'origin'], { cwd: root });
  return r.ok ? normalizeRemote(r.stdout) : undefined;
}

/** A new id from the repo name plus a random suffix, so two repos with one name never share a record. */
export function newRepoId(name: string): string {
  const slug = name.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'repo';
  return `${slug}-${crypto.randomBytes(4).toString('hex')}`;
}

function parseRecord(v: unknown, id: string): RepoRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    id,
    name: str(o.name),
    paths: Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === 'string') : [],
    ...(typeof o.remote === 'string' && o.remote ? { remote: o.remote } : {}),
    revision: typeof o.revision === 'number' ? o.revision : 0,
    linkedAt: str(o.linkedAt),
    updatedAt: str(o.updatedAt),
    settings: o.settings && typeof o.settings === 'object' && !Array.isArray(o.settings) ? (o.settings as Record<string, unknown>) : {},
  };
}

export function readRepoRecord(id: string): RepoRecord | null {
  if (!REPO_ID.test(id)) return null;
  return parseRecord(readJson(reposDir(), `${id}.json`), id);
}

/** Every record in the state folder, newest first. */
export function listRepoRecords(): RepoRecord[] {
  return listDir(reposDir())
    .filter((f) => f.endsWith('.json') && REPO_ID.test(f.slice(0, -5)))
    .map((f) => readRepoRecord(f.slice(0, -5)))
    .filter((r): r is RepoRecord => r !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function writeRecord(record: RepoRecord): boolean {
  return writeHomeFile(path.join('repos', `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
}

/** Where this checkout stands. Reads only; `linkRepo` writes. */
export function repoLink(root: string, config: RepoConfig, opts: { name?: string; remote?: string | undefined } = {}): RepoLink {
  const remote = 'remote' in opts ? opts.remote : repoRemote(root);
  const here = path.resolve(root);
  const raw = config.id;
  if (!raw || !REPO_ID.test(raw)) {
    const found = listRepoRecords().find((r) => r.paths.includes(here)) ?? (remote ? listRepoRecords().find((r) => r.remote === remote) : undefined);
    const bad = raw ? [`pf.json id "${raw}" is not valid (lowercase letters, digits and dashes)`] : [];
    if (found) return { state: 'stale', id: found.id, record: found, reasons: [...bad, `pf.json has no id; pf rp writes back ${found.id}`] };
    return { state: 'unlinked', id: null, record: null, reasons: [...bad, 'not linked yet'] };
  }
  const record = readRepoRecord(raw);
  if (!record) return { state: 'unlinked', id: raw, record: null, reasons: [`pf has no record for id ${raw} on this machine`] };
  const pathMatch = record.paths.includes(here);
  const remoteMatch = !!remote && record.remote === remote;
  if (!pathMatch && !remoteMatch) {
    const seen = [record.paths[0], record.remote].filter(Boolean).join(', ') || 'nowhere';
    return { state: 'foreign', id: raw, record, reasons: [`id ${raw} belongs to a repo pf saw at ${seen}`] };
  }
  const reasons: string[] = [];
  if (!pathMatch) reasons.push(`checkout moved to ${here} (last seen at ${record.paths[0] ?? 'no path'})`);
  if (remote !== record.remote) reasons.push(`remote changed: ${record.remote ?? 'none'} -> ${remote ?? 'none'}`);
  if (opts.name && opts.name !== record.name) reasons.push(`name changed: ${record.name || 'none'} -> ${opts.name}`);
  if (record.revision < REPO_LINK_REVISION) reasons.push(`linked by an older pf (link revision ${record.revision} < ${REPO_LINK_REVISION})`);
  return { state: reasons.length ? 'stale' : 'linked', id: raw, record, reasons };
}

/** Private settings for a trusted link. A `foreign` or `unlinked` checkout gets none. */
export function repoSettings(link: RepoLink): Record<string, unknown> {
  return link.record && (link.state === 'linked' || link.state === 'stale') ? link.record.settings : {};
}

/** Merge settings into a record. False when there is no record or the pf home is read-only. */
export function saveRepoSettings(id: string, patch: Record<string, unknown>): boolean {
  const record = readRepoRecord(id);
  if (!record) return false;
  return writeRecord({ ...record, settings: { ...record.settings, ...patch }, updatedAt: new Date().toISOString() });
}

/** Set `id` in pf.json, first, keeping every other key. False when pf.json is not valid JSON (never overwritten) or cannot be written. */
export function writeRepoId(root: string, id: string): boolean {
  const file = path.join(root, 'pf.json');
  const current = readJson<Record<string, unknown>>(file);
  if (fs.existsSync(file) && !current) return false;
  const { id: _old, ...rest } = current ?? {};
  try {
    fs.writeFileSync(file, JSON.stringify({ id, ...rest }, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

export interface LinkResult {
  ok: boolean;
  id: string;
  /** What changed, for the `pf rp` summary. */
  changes: string[];
}

/**
 * Link this checkout: give pf.json an id when it has none (or `fresh` asks for a new one) and create or
 * refresh the record. Confirm a `foreign` link with the user before calling this without `fresh`.
 */
export function linkRepo(root: string, link: RepoLink, opts: { name: string; remote?: string | undefined; fresh?: boolean; dryRun?: boolean }): LinkResult {
  const remote = 'remote' in opts ? opts.remote : repoRemote(root);
  const here = path.resolve(root);
  const fresh = opts.fresh || !link.id;
  const id = fresh ? newRepoId(opts.name) : link.id!;
  const would = (s: string) => (opts.dryRun ? `would ${s}` : s);
  const changes: string[] = [];
  const base = fresh ? null : link.record;

  const idInFile = readJson<{ id?: unknown }>(root, 'pf.json')?.id;
  if (idInFile !== id) {
    if (!opts.dryRun && !writeRepoId(root, id)) return { ok: false, id, changes: ['pf.json is not valid JSON or cannot be written; fix it and run pf rp again'] };
    changes.push(would(`${idInFile === undefined ? 'add' : 'set'} id ${id} in pf.json`));
  }

  const now = new Date().toISOString();
  const paths = [here, ...(base?.paths ?? []).filter((p) => p !== here && fs.existsSync(p))].slice(0, MAX_PATHS);
  const record: RepoRecord = {
    id,
    name: opts.name,
    paths,
    ...(remote ? { remote } : {}),
    revision: REPO_LINK_REVISION,
    linkedAt: base?.linkedAt || now,
    updatedAt: now,
    settings: base?.settings ?? {},
  };
  const file = `~/.pf/repos/${id}.json`;
  if (!base) changes.push(would(`remember the repo in ${file}`));
  else if (link.state !== 'linked') changes.push(would(`refresh ${file}: ${link.reasons.join('; ')}`));
  else return { ok: true, id, changes: changes.length ? changes : [`linked as ${id} (${file})`] };
  if (!opts.dryRun && !writeRecord(record)) return { ok: false, id, changes: [...changes, `could not write ${file} (is ~/.pf writable?)`] };
  return { ok: true, id, changes };
}
