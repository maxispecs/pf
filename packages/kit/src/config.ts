import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from './constants.js';
import { readJson } from './util.js';

export interface CustomCommand {
  run: string;
  description?: string;
  group?: string;
  /** Relative to the repo root. */
  cwd?: string;
}

/** What the agent may be granted on AWS. A missing list means no limit from this layer. */
export interface AgentAwsScope {
  scopes?: string[];
  regions?: string[];
  maxTtlMinutes?: number;
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

/** Repo config: `pf.json` at the repo root. */
export interface RepoConfig {
  name?: string;
  commands: Record<string, CustomCommand>;
  /** Name of the user's profile this repo uses. */
  profile?: string;
  /** What the repo asks for. It can only narrow the profile's limits, never widen them. */
  agent?: { aws?: AgentAwsScope };
}

/** User config: `~/.pf/config.json`. */
export interface UserConfig {
  /** Agent CLI used to run prompt-only skills: cursor-agent, claude or codex. Auto-detected when unset. */
  agent?: string;
  /** Extra directories scanned for skills. */
  skillDirs?: string[];
  profiles?: Record<string, ProfileConfig>;
  /** Profile used when neither a flag, PF_PROFILE nor pf.json names one. */
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
  return { ...(scopes ? { scopes } : {}), ...(regions ? { regions } : {}), ...(ttl ? { maxTtlMinutes: ttl } : {}) };
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
  const raw = readJson<{ name?: unknown; commands?: unknown; profile?: unknown; agent?: unknown }>(root, 'pf.json');
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
        };
      }
    }
  }
  const scope = isObj(raw?.agent) ? parseAgentAwsScope(raw.agent.aws) : undefined;
  return {
    ...(typeof raw?.name === 'string' ? { name: raw.name } : {}),
    commands,
    ...(typeof raw?.profile === 'string' && raw.profile.trim() ? { profile: raw.profile.trim() } : {}),
    ...(scope ? { agent: { aws: scope } } : {}),
  };
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
