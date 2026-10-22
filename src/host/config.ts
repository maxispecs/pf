import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../util.js';

/** Where a secret lives. pf reads it with the instance role at run time and never stores it. */
export type SecretSource = 'ssm' | 'secretsmanager';

export interface SecretRef {
  source: SecretSource;
  /** SSM parameter name or Secrets Manager secret id. */
  name: string;
}

/** Host config: `/etc/pulpfixer/host.json`. Holds secret names, never secret values. */
export interface HostConfig {
  /** AWS region. Defaults to the instance's region from IMDS. */
  region?: string;
  /** Env var name -> where its value comes from. */
  secrets: Record<string, SecretRef>;
  /** pulpfixer version `pf host update` installs. */
  version: string;
  /** Also update the agent CLI on `pf host update`. */
  updateAgent: boolean;
  /** Model for `pf host fix`. The agent CLI's default when unset. */
  model?: string;
  /** Spending cap per `pf host fix` run, in USD. */
  maxBudgetUsd: number;
  /** systemd units the agent may restart (with --apply). */
  services: string[];
  /** One log file per `pf host fix` run. */
  auditDir: string;
}

export const SECRET_SOURCES: SecretSource[] = ['ssm', 'secretsmanager'];
export const DEFAULT_PREFIX = '/pulpfixer';
/** Secrets pf knows about: the registry token for updates and the agent's API key. */
export const NPM_TOKEN = 'NPM_TOKEN';
export const AGENT_KEY = 'ANTHROPIC_API_KEY';

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SECRET_NAME = /^[\w/.\-+=@:]+$/;
const UNIT_NAME = /^[\w@.:-]+$/;

/** Directory for host config and the npmrc. PF_HOST_DIR overrides it (used by tests). */
export function hostDir(): string {
  return process.env.PF_HOST_DIR ?? '/etc/pulpfixer';
}

export function hostConfigPath(): string {
  return path.join(hostDir(), 'host.json');
}

/** npmrc for host installs: the cellars auth line reading ${NPM_TOKEN}, never the token. */
export function hostNpmrcPath(): string {
  return path.join(hostDir(), 'npmrc');
}

/** Secret names for a source and prefix: `<prefix>/npm-token`, `<prefix>/anthropic-api-key`. */
export function defaultSecrets(source: SecretSource = 'ssm', prefix = DEFAULT_PREFIX): Record<string, SecretRef> {
  const p = prefix.replace(/\/+$/, '');
  const name = (leaf: string) => (source === 'ssm' ? `${p}/${leaf}` : `${p.replace(/^\//, '')}/${leaf}`);
  return {
    [NPM_TOKEN]: { source, name: name('npm-token') },
    [AGENT_KEY]: { source, name: name('anthropic-api-key') },
  };
}

export function defaultHostConfig(): HostConfig {
  return {
    secrets: defaultSecrets(),
    version: 'latest',
    updateAgent: true,
    maxBudgetUsd: 5,
    services: [],
    auditDir: '/var/log/pulpfixer',
  };
}

export const validUnit = (name: string): boolean => UNIT_NAME.test(name) && !name.startsWith('-');

/** Keep only well-formed values; anything else falls back to the default. */
export function parseHostConfig(raw: unknown): HostConfig {
  const d = defaultHostConfig();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const secrets: Record<string, SecretRef> = {};
  if (o.secrets && typeof o.secrets === 'object') {
    for (const [env, v] of Object.entries(o.secrets as Record<string, unknown>)) {
      const ref = v as Partial<SecretRef> | null;
      if (!ENV_NAME.test(env) || !ref || typeof ref !== 'object') continue;
      if (!SECRET_SOURCES.includes(ref.source as SecretSource) || typeof ref.name !== 'string' || !SECRET_NAME.test(ref.name)) continue;
      secrets[env] = { source: ref.source as SecretSource, name: ref.name };
    }
  }
  return {
    ...(typeof o.region === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region) ? { region: o.region } : {}),
    secrets: Object.keys(secrets).length ? secrets : d.secrets,
    version: typeof o.version === 'string' && /^(latest|\d+(\.\d+){0,2})$/.test(o.version) ? o.version : d.version,
    updateAgent: typeof o.updateAgent === 'boolean' ? o.updateAgent : d.updateAgent,
    ...(typeof o.model === 'string' && /^[\w.\-:[\]]+$/.test(o.model) ? { model: o.model } : {}),
    maxBudgetUsd: typeof o.maxBudgetUsd === 'number' && o.maxBudgetUsd > 0 ? o.maxBudgetUsd : d.maxBudgetUsd,
    services: Array.isArray(o.services) ? o.services.filter((s): s is string => typeof s === 'string' && validUnit(s)) : d.services,
    auditDir: typeof o.auditDir === 'string' && path.isAbsolute(o.auditDir) ? o.auditDir : d.auditDir,
  };
}

export function hostConfigExists(): boolean {
  return fs.existsSync(hostConfigPath());
}

export function loadHostConfig(): HostConfig {
  return parseHostConfig(readJson(hostConfigPath()));
}

/** Write the host config, readable by root only. */
export function saveHostConfig(config: HostConfig): void {
  fs.mkdirSync(hostDir(), { recursive: true, mode: 0o755 });
  fs.writeFileSync(hostConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
