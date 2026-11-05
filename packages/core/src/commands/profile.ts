import type { ProfileConfig } from '@pulpfixer/kit/config';
import type { Context } from '@pulpfixer/kit/context';
import { formatCmd } from '@pulpfixer/kit/exec';
import { ACCOUNT_ID, PROFILE_NAME, removeProfile, resolveProfile, saveProfile, setDefaultProfile } from '@pulpfixer/kit/profiles';
import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { ask } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, h2, table, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption, which } from '@pulpfixer/kit/util';
import { DEFAULT_MAX_TTL, DEFAULT_SCOPES, describeLimits, HARD_MAX_TTL, projectAws, SCOPE_NAMES, whoami } from '@pulpfixer/plugin-aws';

const AWS_PROFILE_NAME = /^[\w.@+-]{1,128}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

const list = (v: string | undefined): string[] | undefined => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean));

function fail(message: string, code = 2): number {
  process.stderr.write(`${badgeLabel('error', err())} ${message}\n`);
  return code;
}

function listProfiles(ctx: Context): number {
  const c = out();
  const profiles = Object.entries(ctx.user.profiles ?? {});
  const here = resolveProfile(ctx);
  if (profiles.length === 0) {
    process.stdout.write(`${c.dim('No profiles yet.')}\n`);
    process.stderr.write(`${err().dim('Add one:')} ${termLine('pf profile add <name> --aws-profile <aws-profile> --account <id> --region <region>', err())}\n`);
    return 0;
  }
  const rows = profiles.map(([name, p]) => [
    `${name}${ctx.user.defaultProfile === name ? c.dim(' (default)') : ''}`,
    p.aws?.profile ?? c.dim('-'),
    p.aws?.account ?? c.dim('not pinned'),
    p.aws?.region ?? c.dim('-'),
    (p.agent?.aws?.scopes ?? DEFAULT_SCOPES).join(', '),
  ]);
  process.stdout.write(table(['profile', 'aws profile', 'account', 'region', 'agent scopes'], rows, c) + '\n');
  if (here) process.stdout.write(`${c.dim('here:')} ${here.name} ${c.dim(`(from ${here.source}${here.config ? '' : ', not configured'})`)}\n`);
  return 0;
}

function showProfile(ctx: Context, name: string | undefined): number {
  const c = out();
  const p = projectAws(ctx, name);
  if (!p.ok) return fail(p.problem, 1);
  const rows: [string, string][] = [
    ['profile', `${p.profile.name} ${c.dim(`(from ${p.profile.source})`)}`],
    ['aws profile', p.target.profile],
    ['account', p.account ?? c.dim('not pinned')],
    ['region', p.target.region ?? c.dim('from the AWS profile')],
    ['agent limits', describeLimits(p.limits)],
  ];
  for (const [k, v] of rows) process.stdout.write(`  ${c.dim(k.padEnd(13))} ${v}\n`);
  if (ctx.config.agent?.aws) process.stdout.write(`  ${c.dim(''.padEnd(13))} ${c.dim('narrowed by this repo\'s pf.json')}\n`);
  return 0;
}

function useProfile(ctx: Context, name: string | undefined, dryRun: boolean): number {
  if (!name) return fail(`say which profile: ${termLine('pf profile use <name>', err())}`);
  if (!ctx.user.profiles?.[name]) return fail(`no profile named "${name}". Add it with ${termLine(`pf profile add ${name}`, err())}`);
  if (dryRun) {
    process.stderr.write(`${err().dim('would make')} ${name} ${err().dim('the default profile')}\n`);
    return 0;
  }
  if (!setDefaultProfile(name)) return fail('could not write ~/.pf/config.json', 1);
  process.stderr.write(`${err().green('✓')} ${name} is the default profile\n`);
  return 0;
}

interface ProfileFlags {
  awsProfile?: string | undefined;
  account?: string | undefined;
  region?: string | undefined;
  scopes?: string[] | undefined;
  regions?: string[] | undefined;
  maxTtl?: string | undefined;
}

/** Check each value; returns an error message or null. */
export function validateProfileFlags(f: ProfileFlags): string | null {
  if (f.awsProfile !== undefined && !AWS_PROFILE_NAME.test(f.awsProfile)) return `"${f.awsProfile}" is not an AWS profile name`;
  if (f.account !== undefined && f.account !== '' && !ACCOUNT_ID.test(f.account)) return 'an account id is 12 digits';
  if (f.region !== undefined && f.region !== '' && !REGION.test(f.region)) return `"${f.region}" is not a region (e.g. eu-west-1)`;
  const badScope = f.scopes?.find((s) => !SCOPE_NAMES.includes(s));
  if (badScope) return `unknown scope "${badScope}". Scopes: ${SCOPE_NAMES.join(', ')}`;
  const badRegion = f.regions?.find((r) => !REGION.test(r));
  if (badRegion) return `"${badRegion}" is not a region (e.g. eu-west-1)`;
  if (f.maxTtl !== undefined) {
    const n = Number(f.maxTtl);
    if (!Number.isInteger(n) || n < 1 || n > HARD_MAX_TTL) return `--max-ttl is whole minutes from 1 to ${HARD_MAX_TTL}`;
  }
  return null;
}

/** Apply flags onto an existing profile; an empty string clears a field. */
export function mergeProfile(current: ProfileConfig, f: ProfileFlags): ProfileConfig {
  const aws = { ...(current.aws ?? {}) };
  const set = (k: 'profile' | 'account' | 'region', v: string | undefined) => {
    if (v === undefined) return;
    if (v === '') delete aws[k];
    else aws[k] = v;
  };
  set('profile', f.awsProfile);
  set('account', f.account);
  set('region', f.region);
  const scope = { ...(current.agent?.aws ?? {}) };
  if (f.scopes) scope.scopes = f.scopes;
  if (f.regions) scope.regions = f.regions;
  if (f.maxTtl !== undefined) scope.maxTtlMinutes = Number(f.maxTtl);
  return { ...(Object.keys(aws).length ? { aws } : {}), ...(Object.keys(scope).length ? { agent: { aws: scope } } : {}) };
}

/** Ask for each value, starting from what is saved. Null when cancelled. */
async function wizard(name: string, current: ProfileConfig): Promise<ProfileFlags | null> {
  const awsProfile = await ask('AWS profile (from ~/.aws/config)', {
    ...(current.aws?.profile ? { initial: current.aws.profile } : {}),
    placeholder: `${name}-readonly`,
    validate: (v) => (AWS_PROFILE_NAME.test(v) ? null : 'enter an AWS profile name'),
  });
  if (awsProfile === null) return null;
  const account = await ask('Account id to pin (recommended)', {
    initial: current.aws?.account ?? '',
    placeholder: '123456789012',
    validate: (v) => (!v || ACCOUNT_ID.test(v) ? null : '12 digits, or empty to skip'),
  });
  if (account === null) return null;
  const region = await ask('Region (optional)', { initial: current.aws?.region ?? '', placeholder: 'taken from the AWS profile', validate: (v) => (!v || REGION.test(v) ? null : 'e.g. eu-west-1') });
  if (region === null) return null;
  const scopes = await ask(`Agent scopes (${SCOPE_NAMES.join(', ')})`, {
    initial: (current.agent?.aws?.scopes ?? DEFAULT_SCOPES).join(','),
    validate: (v) => validateProfileFlags({ scopes: list(v) ?? [] }),
  });
  if (scopes === null) return null;
  const ttl = await ask('Longest grant, minutes', { initial: String(current.agent?.aws?.maxTtlMinutes ?? DEFAULT_MAX_TTL), validate: (v) => validateProfileFlags({ maxTtl: v }) });
  if (ttl === null) return null;
  return { awsProfile, account, region, scopes: list(scopes) ?? [], maxTtl: ttl };
}

async function addProfile(ctx: Context, args: string[], dryRun: boolean): Promise<number> {
  const flags: ProfileFlags = {
    awsProfile: takeOption(args, '--aws-profile'),
    account: takeOption(args, '--account'),
    region: takeOption(args, '--region'),
    scopes: list(takeOption(args, '--scopes')),
    regions: list(takeOption(args, '--regions')),
    maxTtl: takeOption(args, '--max-ttl'),
  };
  let name = args[0];
  if (!name && interactive()) name = (await ask('Profile name', { placeholder: 'acme', validate: (v) => (PROFILE_NAME.test(v) ? null : 'letters, digits, . _ -') })) ?? undefined;
  if (!name) return fail(`give a name: ${termLine('pf profile add <name> [--aws-profile p] [--account id] [--region r] [--scopes a,b] [--regions r1,r2] [--max-ttl min]', err())}`);
  if (!PROFILE_NAME.test(name)) return fail(`"${name}" is not a profile name (letters, digits, . _ -)`);
  const current = ctx.user.profiles?.[name] ?? {};
  let patch = flags;
  if (Object.values(flags).every((v) => v === undefined)) {
    if (!interactive()) return fail('no terminal: pass the values as flags (--aws-profile, --account, --region, --scopes, --regions, --max-ttl)');
    process.stderr.write(`${err().dim(`Profile ${name}. Enter keeps the shown value, esc cancels.`)}\n`);
    const answers = await wizard(name, current);
    if (!answers) {
      process.stderr.write(err().dim('cancelled, nothing saved\n'));
      return 130;
    }
    patch = answers;
  }
  const problem = validateProfileFlags(patch);
  if (problem) return fail(problem);
  const next = mergeProfile(current, patch);
  if (!next.aws?.profile) return fail('a profile needs an AWS profile: --aws-profile <name>');
  if (dryRun) {
    process.stderr.write(`${err().dim(`would save profile ${name}:`)}\n${JSON.stringify(next, null, 2)}\n`);
    return 0;
  }
  if (!saveProfile(name, next)) return fail('could not write ~/.pf/config.json', 1);
  process.stderr.write(`${err().green('✓')} saved profile ${name}\n`);
  const c = err();
  process.stderr.write(`${c.dim('Use it in a repo with')} ${termLine(`"profile": "${name}"`, c)} ${c.dim('in pf.json, or everywhere with')} ${termLine(`pf profile use ${name}`, c)}\n`);
  if (!next.aws.account) process.stderr.write(`${c.dim('Pin the account so pf never reads the wrong one:')} ${termLine(`pf profile add ${name} --account <id>`, c)}\n`);
  return 0;
}

function dropProfile(ctx: Context, name: string | undefined, dryRun: boolean): number {
  if (!name) return fail(`say which profile: ${termLine('pf profile remove <name>', err())}`);
  if (!ctx.user.profiles?.[name]) return fail(`no profile named "${name}"`);
  if (dryRun) {
    process.stderr.write(`${err().dim('would remove profile')} ${name}\n`);
    return 0;
  }
  if (!removeProfile(name)) return fail('could not write ~/.pf/config.json', 1);
  process.stderr.write(`${err().green('✓')} removed profile ${name}\n`);
  return 0;
}

async function checkProfile(ctx: Context, name: string | undefined, dryRun: boolean): Promise<number> {
  const p = projectAws(ctx, name);
  if (!p.ok) return fail(p.problem, 1);
  const argv = ['aws', 'sts', 'get-caller-identity', '--output', 'json', '--profile', p.target.profile, ...(p.target.region ? ['--region', p.target.region] : [])];
  if (dryRun) {
    process.stderr.write(`${err().dim('would run')} ${termLine(formatCmd({ argv }), err())}\n`);
    return 0;
  }
  if (!which('aws')) return fail('the aws CLI is not on PATH', 127);
  const w = await whoami(p.target, p.account);
  process.stdout.write(`${h2(`profile ${p.profile.name}`, out())}\n${w.text}\n`);
  if (!w.ok) return 1;
  process.stderr.write(`${err().green('✓')} ${p.account ? `credentials resolve to the pinned account ${p.account}` : 'credentials work (no account pinned)'}\n`);
  return 0;
}

export const profileCommand: Command = {
  name: 'profile',
  summary: 'Project profiles: AWS account and what the agent may read',
  group: 'Tools',
  usage: 'pf profile [list | show [name] | use <name> | add [name] [--aws-profile p] [--account id] [--region r] [--scopes a,b] [--regions r1,r2] [--max-ttl min] | remove <name> | check [name]] [--dry-run]',
  async run(ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const sub = rest.shift() ?? 'list';
    switch (sub) {
      case 'list':
      case 'ls':
        return listProfiles(ctx);
      case 'show':
        return showProfile(ctx, rest[0]);
      case 'use':
        return useProfile(ctx, rest[0], dryRun);
      case 'add':
      case 'set':
        return addProfile(ctx, rest, dryRun);
      case 'remove':
      case 'rm':
        return dropProfile(ctx, rest[0], dryRun);
      case 'check':
        return checkProfile(ctx, rest[0], dryRun);
      default:
        return fail(`unknown subcommand "${sub}". ${termLine(profileCommand.usage, err())}`);
    }
  },
};
