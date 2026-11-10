import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProfileConfig } from '@pulpfixer/kit/config';
import { PROFILE_NAME } from '@pulpfixer/kit/profiles';

/**
 * The profiles in `~/.aws/config`, read for their names, account, region and kind only. The
 * credentials file is never opened, and no key, token or start URL is kept. Used to link a repo to
 * a profile pf supports: the user picks one of these, pf registers it, and the repo names it.
 */
export interface AwsProfileInfo {
  name: string;
  account?: string;
  region?: string;
  kind: 'sso' | 'role' | 'other';
}

export function awsConfigPath(): string {
  return process.env.AWS_CONFIG_FILE?.trim() || path.join(os.homedir(), '.aws', 'config');
}

const ACCOUNT = /^\d{12}$/;

/** Parse the INI text of an AWS config. Only `default` and `profile <name>` sections are profiles. */
export function parseAwsConfig(text: string): AwsProfileInfo[] {
  const sections: { name: string; values: Record<string, string> }[] = [];
  let current: { name: string; values: Record<string, string> } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const title = header[1]!.trim();
      const m = title === 'default' ? 'default' : /^profile\s+(.+)$/.exec(title)?.[1]?.trim();
      current = m ? { name: m, values: {} } : null;
      if (current) sections.push(current);
      continue;
    }
    const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && current) current.values[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  return sections.map(({ name, values }) => {
    const roleAccount = /^arn:aws[\w-]*:iam::(\d{12}):/.exec(values.role_arn ?? '')?.[1];
    const account = [values.sso_account_id, roleAccount].find((a) => a && ACCOUNT.test(a));
    const kind: AwsProfileInfo['kind'] = values.sso_account_id || values.sso_session ? 'sso' : values.role_arn ? 'role' : 'other';
    return { name, kind, ...(account ? { account } : {}), ...(values.region ? { region: values.region } : {}) };
  });
}

/** Profiles from the AWS config file; empty when there is none. */
export function listAwsProfiles(file = awsConfigPath()): AwsProfileInfo[] {
  try {
    return parseAwsConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** One way to link a repo: a profile pf already has, or an AWS profile pf could register. */
export interface LinkCandidate {
  kind: 'registered' | 'aws';
  /** pf profile name (registered) or AWS profile name (aws). */
  name: string;
  awsProfile: string;
  account?: string;
  region?: string;
  score: number;
  reasons: string[];
}

export interface RepoHints {
  accounts: string[];
  regions: string[];
  /** The repo's name, to prefer profiles named like it. */
  repoName?: string | undefined;
}

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

function score(hints: RepoHints, names: string[], account?: string, region?: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let n = 0;
  if (account && hints.accounts.includes(account)) {
    n += 4;
    reasons.push(`account ${account} appears in the repo`);
  }
  if (region && hints.regions.includes(region)) {
    n += 1;
    reasons.push(`region ${region} appears in the repo`);
  }
  const repo = hints.repoName ? tokens(hints.repoName) : [];
  if (repo.length && names.some((name) => tokens(name).some((t) => repo.includes(t)))) {
    n += 1;
    reasons.push('named like the repo');
  }
  return { score: n, reasons };
}

/**
 * Rank link candidates, best first. Registered profiles come before unregistered AWS profiles at the
 * same score, because the registry is what pf supports. An AWS profile that a registered profile
 * already points at is shown once, as the registered one.
 */
export function matchProfiles(hints: RepoHints, aws: AwsProfileInfo[], registered: Record<string, ProfileConfig>): LinkCandidate[] {
  const awsByName = new Map(aws.map((p) => [p.name, p]));
  const out: LinkCandidate[] = [];
  const covered = new Set<string>();
  for (const [name, p] of Object.entries(registered)) {
    const awsProfile = p.aws?.profile;
    if (!awsProfile) continue;
    covered.add(awsProfile);
    const info = awsByName.get(awsProfile);
    const account = p.aws?.account ?? info?.account;
    const region = p.aws?.region ?? info?.region;
    const s = score(hints, [name, awsProfile], account, region);
    out.push({ kind: 'registered', name, awsProfile, ...(account ? { account } : {}), ...(region ? { region } : {}), ...s });
  }
  for (const info of aws) {
    if (covered.has(info.name)) continue;
    const s = score(hints, [info.name], info.account, info.region);
    out.push({ kind: 'aws', name: info.name, awsProfile: info.name, ...(info.account ? { account: info.account } : {}), ...(info.region ? { region: info.region } : {}), ...s });
  }
  return out.sort((a, b) => b.score - a.score || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'registered' ? -1 : 1));
}

/** A pf profile name for an AWS profile, free of the names already taken. */
export function suggestProfileName(awsProfile: string, taken: string[]): string {
  let base = awsProfile.replace(/[^\w.-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 60) || 'profile';
  if (!PROFILE_NAME.test(base)) base = 'profile';
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 10000}`;
}
