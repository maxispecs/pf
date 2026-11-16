import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from './constants.js';
import { exists, readJson, readText } from './util.js';

export interface CustomCommand {
  run: string;
  description?: string;
  group?: string;
  /** Relative to the repo root. */
  cwd?: string;
  /** The command takes a message as its last argument (a deploy that commits): `pf d "text"` passes it on. */
  message?: boolean;
}

/** What the agent may be granted on AWS. A missing list means no limit from this layer. */
export interface AgentAwsScope {
  scopes?: string[];
  regions?: string[];
  maxTtlMinutes?: number;
  /**
   * Fix actions (`service operation`, e.g. `ecs update-service`) the agent may ask to run, each approved
   * by the user one call at a time. Missing means none: it is opt-in on the user's profile, and a repo can only narrow it.
   */
  actions?: string[];
}

/** A named project profile in `~/.pf/config.json`: which AWS account to use and how far the agent may go. Nothing secret. */
export interface ProfileConfig {
  aws?: {
    /** Profile name in ~/.aws/config. */
    profile?: string;
    /** 12-digit account id the profile must resolve to. */
    account?: string;
    region?: string;
  };
  agent?: { aws?: AgentAwsScope };
}

/** The repo config file at the repo root. */
export const REPO_CONFIG = 'pulpfixer.json';
/** The name older pf versions wrote. Still read while no pulpfixer.json exists; `pf rp` converts it. */
export const LEGACY_REPO_CONFIG = 'pf.json';

/** The repo's config file name: pulpfixer.json, else a legacy pf.json not converted yet, else pulpfixer.json (to create). */
export function repoConfigName(root: string): string {
  return !exists(root, REPO_CONFIG) && exists(root, LEGACY_REPO_CONFIG) ? LEGACY_REPO_CONFIG : REPO_CONFIG;
}

export function repoConfigPath(root: string): string {
  return path.join(root, repoConfigName(root));
}

export function hasRepoConfig(root: string): boolean {
  return exists(root, REPO_CONFIG) || exists(root, LEGACY_REPO_CONFIG);
}

export type ConfigMigration =
  /** No config file at all. */
  | { state: 'none' }
  /** pulpfixer.json only. */
  | { state: 'current' }
  /** pf.json was renamed to pulpfixer.json (or would be, on a dry run). `removed`: it matched an existing pulpfixer.json and was deleted. */
  | { state: 'converted'; removed: boolean }
  /** Both exist and differ: pulpfixer.json is the one read, pf.json is left for the user to merge. */
  | { state: 'both' }
  | { state: 'failed'; error: string };

/**
 * Convert a legacy pf.json to pulpfixer.json. The content is kept as is (the format did not change), so this
 * is a rename. A pf.json identical to an existing pulpfixer.json is deleted; one that differs is never touched.
 */
export function migrateRepoConfig(root: string, opts: { dryRun?: boolean } = {}): ConfigMigration {
  const legacy = path.join(root, LEGACY_REPO_CONFIG);
  const current = path.join(root, REPO_CONFIG);
  if (!fs.existsSync(legacy)) return { state: fs.existsSync(current) ? 'current' : 'none' };
  const same = fs.existsSync(current) && readText(current)?.trim() === readText(legacy)?.trim();
  if (fs.existsSync(current) && !same) return { state: 'both' };
  if (opts.dryRun) return { state: 'converted', removed: same };
  try {
    if (same) fs.rmSync(legacy);
    else fs.renameSync(legacy, current);
    return { state: 'converted', removed: same };
  } catch (e) {
    return { state: 'failed', error: (e as Error).message };
  }
}

/** Repo config: `pulpfixer.json` (or a legacy `pf.json`) at the repo root. */
export interface RepoConfig {
  /** Links the repo to its record in `~/.pf/repos/<id>.json` (see `repo-link.ts`). Written by `pf rp`. */
  id?: string;
  name?: string;
  commands: Record<string, CustomCommand>;
  /** Name of the user's profile this repo uses. */
  profile?: string;
  /** What the repo asks for. It can only narrow the profile's limits, never widen them. */
  agent?: { aws?: AgentAwsScope };
  /**
   * Settings of the Background Tone extension (`@pulpfixer/ext-bg-tone`): `color`, `logo`, ... The extension
   * reads and writes this section itself; `pf rp` sets `logo`. Kept as a plain object, pf does not interpret it.
   */
  bgTone?: Record<string, unknown>;
}

/** User config: `~/.pf/config.json`. */
export interface UserConfig {
  /** Agent CLI used to run prompt-only skills: cursor-agent, claude or codex. Auto-detected when unset. */
  agent?: string;
  /** Extra directories scanned for skills. */
  skillDirs?: string[];
  profiles?: Record<string, ProfileConfig>;
  /** Profile used when neither a flag, PF_PROFILE nor pulpfixer.json names one. */
  defaultProfile?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : undefined);

/** Keep only well-formed fields of an `agent.aws` block. */
export function parseAgentAwsScope(v: unknown): AgentAwsScope | undefined {
  if (!isObj(v)) return undefined;
  const scopes = strList(v.scopes);
  const regions = strList(v.regions);
  const ttl = typeof v.maxTtlMinutes === 'number' && v.maxTtlMinutes > 0 ? Math.floor(v.maxTtlMinutes) : undefined;
  const actions = strList(v.actions);
  return { ...(scopes ? { scopes } : {}), ...(regions ? { regions } : {}), ...(ttl ? { maxTtlMinutes: ttl } : {}), ...(actions ? { actions } : {}) };
}

export function parseProfile(v: unknown): ProfileConfig {
  if (!isObj(v)) return {};
  const out: ProfileConfig = {};
  if (isObj(v.aws)) {
    const a = v.aws;
    const pick = (k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? { [k]: (a[k] as string).trim() } : {});
    out.aws = { ...pick('profile'), ...pick('account'), ...pick('region') };
  }
  const scope = isObj(v.agent) ? parseAgentAwsScope(v.agent.aws) : undefined;
  if (scope) out.agent = { aws: scope };
  return out;
}

export function loadRepoConfig(root: string): RepoConfig {
  const raw = readJson<{ id?: unknown; name?: unknown; commands?: unknown; profile?: unknown; agent?: unknown; bgTone?: unknown }>(repoConfigPath(root));
  const commands: Record<string, CustomCommand> = {};
  if (raw && raw.commands && typeof raw.commands === 'object') {
    for (const [name, v] of Object.entries(raw.commands as Record<string, unknown>)) {
      if (typeof v === 'string') {
        commands[name] = { run: v };
      } else if (v && typeof v === 'object' && typeof (v as { run?: unknown }).run === 'string') {
        const o = v as CustomCommand;
        commands[name] = {
          run: o.run,
          ...(typeof o.description === 'string' ? { description: o.description } : {}),
          ...(typeof o.group === 'string' ? { group: o.group } : {}),
          ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
          ...(o.message === true ? { message: true } : {}),
        };
      }
    }
  }
  const scope = isObj(raw?.agent) ? parseAgentAwsScope(raw.agent.aws) : undefined;
  return {
    ...(typeof raw?.id === 'string' && raw.id.trim() ? { id: raw.id.trim() } : {}),
    ...(typeof raw?.name === 'string' ? { name: raw.name } : {}),
    commands,
    ...(typeof raw?.profile === 'string' && raw.profile.trim() ? { profile: raw.profile.trim() } : {}),
    ...(scope ? { agent: { aws: scope } } : {}),
    ...(isObj(raw?.bgTone) ? { bgTone: raw.bgTone } : {}),
  };
}

export type SectionWrite = { ok: true; changed: boolean } | { ok: false; error: string };

/**
 * Merge `values` into an object section of the repo config (`bgTone`), creating the file when there is none.
 * Keeps every other key, the indentation and the trailing newline. A file that is not a JSON object (or a section
 * that is not an object) is never overwritten. With `dryRun` nothing is written, `changed` says whether it would be.
 */
export function setRepoConfigSection(root: string, section: string, values: Record<string, unknown>, opts: { dryRun?: boolean } = {}): SectionWrite {
  const file = repoConfigPath(root);
  const name = path.basename(file);
  const text = readText(file);
  let doc: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObj(parsed)) return { ok: false, error: `${name} is not a JSON object` };
      doc = parsed;
    } catch {
      return { ok: false, error: `${name} is not valid JSON` };
    }
  }
  const current = doc[section];
  if (current !== undefined && !isObj(current)) return { ok: false, error: `"${section}" in ${name} is not an object` };
  const next = { ...(current ?? {}) } as Record<string, unknown>;
  let changed = false;
  for (const [k, v] of Object.entries(values)) {
    if (k === '__proto__' || JSON.stringify(next[k]) === JSON.stringify(v)) continue;
    next[k] = v;
    changed = true;
  }
  if (!changed) return { ok: true, changed: false };
  if (opts.dryRun) return { ok: true, changed: true };
  doc[section] = next;
  const indent = text ? (/^([ \t]+)"/m.exec(text)?.[1] ?? 2) : 2;
  try {
    fs.writeFileSync(file, JSON.stringify(doc, null, indent) + (text === null || text.trim() === '' || text.endsWith('\n') ? '\n' : ''));
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, error: `could not write ${name}: ${(e as Error).message}` };
  }
}

export function userConfigPath(): string {
  return path.join(pfHome(), 'config.json');
}

export function loadUserConfig(): UserConfig {
  const raw = readJson<UserConfig & Record<string, unknown>>(userConfigPath()) ?? {};
  const { profiles, defaultProfile, ...rest } = raw;
  return {
    ...rest,
    ...(isObj(profiles) ? { profiles: Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, parseProfile(v)])) } : {}),
    ...(typeof defaultProfile === 'string' && defaultProfile.trim() ? { defaultProfile: defaultProfile.trim() } : {}),
  };
}

interface History {
  /** Last menu entry run, keyed by repo root. */
  menu?: Record<string, string>;
}

function historyPath(): string {
  return path.join(pfHome(), 'history.json');
}

/** The menu entry this repo ran last, so the menu can start on it. */
export function lastMenuChoice(key: string): string | undefined {
  return readJson<History>(historyPath())?.menu?.[key];
}

/** Remember the menu entry just chosen. Never throws. */
export function rememberMenuChoice(key: string, name: string): void {
  const history = readJson<History>(historyPath()) ?? {};
  writeHomeFile('history.json', JSON.stringify({ ...history, menu: { ...(history.menu ?? {}), [key]: name } }, null, 2) + '\n');
}

/** Write a file under the pf home; returns false (never throws) when the home is read-only. */
export function writeHomeFile(rel: string, content: string): boolean {
  try {
    const p = path.join(pfHome(), rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return true;
  } catch {
    return false;
  }
}
