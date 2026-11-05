import { userConfigPath, writeHomeFile, type AgentAwsScope, type ProfileConfig, type RepoConfig, type UserConfig } from './config.js';
import { readJson } from './util.js';

/**
 * Project profiles come in two layers. `~/.pf/config.json` maps a name to an AWS profile, a pinned
 * account and the most the agent may be granted. A repo's `pf.json` names the profile it uses and may
 * narrow those limits. A cloned repo is not trusted, so it can never widen them.
 */

export const PROFILE_NAME = /^[a-zA-Z0-9][\w.-]{0,63}$/;
export const ACCOUNT_ID = /^\d{12}$/;

export type ProfileSource = 'flag' | 'env' | 'pf.json' | 'default';

export interface ResolvedProfile {
  name: string;
  source: ProfileSource;
  /** Null when no profile of that name is configured. */
  config: ProfileConfig | null;
}

/** Which profile applies: `--profile`, then PF_PROFILE, then `pf.json`, then the user's default. Null when none is named. */
export function resolveProfile(
  cfg: { config: RepoConfig; user: UserConfig },
  opts: { flag?: string | undefined; env?: string | undefined } = {},
): ResolvedProfile | null {
  const env = 'env' in opts ? opts.env : process.env.PF_PROFILE;
  const pick = (name: string | undefined, source: ProfileSource): ResolvedProfile | null => {
    const n = name?.trim();
    if (!n) return null;
    return { name: n, source, config: cfg.user.profiles?.[n] ?? null };
  };
  return pick(opts.flag, 'flag') ?? pick(env, 'env') ?? pick(cfg.config.profile, 'pf.json') ?? pick(cfg.user.defaultProfile, 'default');
}

/** Effective limits: the user's caps (defaults applied by the caller) narrowed by what the repo asks for. */
export interface Limits {
  scopes: string[];
  /** Null means any region. */
  regions: string[] | null;
  maxTtlMinutes: number;
}

export function narrowLimits(caps: Limits, repo: AgentAwsScope | undefined): Limits {
  if (!repo) return caps;
  const scopes = repo.scopes ? caps.scopes.filter((s) => repo.scopes!.includes(s)) : caps.scopes;
  const regions = repo.regions ? (caps.regions ? caps.regions.filter((r) => repo.regions!.includes(r)) : repo.regions) : caps.regions;
  const maxTtlMinutes = repo.maxTtlMinutes ? Math.min(caps.maxTtlMinutes, repo.maxTtlMinutes) : caps.maxTtlMinutes;
  return { scopes, regions, maxTtlMinutes };
}

type Obj = Record<string, unknown>;

function writeConfig(update: (config: Obj) => Obj): boolean {
  const config = readJson<Obj>(userConfigPath()) ?? {};
  return writeHomeFile('config.json', JSON.stringify(update(config), null, 2) + '\n');
}

const profilesOf = (config: Obj): Obj => (config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles) ? (config.profiles as Obj) : {});

/** Add or replace a profile. False when the pf home is read-only. */
export function saveProfile(name: string, profile: ProfileConfig): boolean {
  return writeConfig((config) => ({ ...config, profiles: { ...profilesOf(config), [name]: profile } }));
}

/** Remove a profile (and the default when it pointed at it). */
export function removeProfile(name: string): boolean {
  return writeConfig((config) => {
    const { [name]: _gone, ...profiles } = profilesOf(config);
    const next: Obj = { ...config, profiles };
    if (next.defaultProfile === name) delete next.defaultProfile;
    return next;
  });
}

export function setDefaultProfile(name: string): boolean {
  return writeConfig((config) => ({ ...config, defaultProfile: name }));
}
