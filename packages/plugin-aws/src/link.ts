import { refreshContext, type Context } from '@pulpfixer/kit/context';
import { linkRepoProfile, saveProfile } from '@pulpfixer/kit/profiles';
import { listAwsProfiles, matchProfiles, suggestProfileName, type LinkCandidate } from './awsconfig.js';
import { scanAwsHints, type AwsHints } from './infra.js';

/**
 * Linking a repo to an AWS profile pf supports. The registry is `profiles` in `~/.pf/config.json`:
 * only a registered profile can be used. Linking either picks a registered profile, or registers an
 * existing `~/.aws/config` profile first (name, pinned account, region; nothing secret), and then
 * names the profile in the repo's `pf.json`. The user always makes the choice: in `pf t`'s wizard or
 * in the dialog of `pf_aws_link_profile`.
 */

export interface LinkChoices {
  hints: AwsHints;
  candidates: LinkCandidate[];
}

/** What the repo says (accounts, regions) matched against the registry and `~/.aws/config`, best first. */
export function linkChoices(ctx: Context, hints: AwsHints = scanAwsHints(ctx.repo?.root ?? ctx.workdir)): LinkChoices {
  const repoName = ctx.config.name ?? ((ctx.repo?.root ?? ctx.workdir).split(/[\\/]/).pop() || undefined);
  return { hints, candidates: matchProfiles({ accounts: hints.accounts, regions: hints.regions, repoName }, listAwsProfiles(), ctx.user.profiles ?? {}) };
}

/** How a candidate reads in a list or dialog. */
export function candidateLabel(c: LinkCandidate): string {
  return c.kind === 'registered' ? `${c.name} (registered)` : `${c.awsProfile} (new, from ~/.aws/config)`;
}

export function candidateDetail(c: LinkCandidate): string {
  const bits = [`AWS profile ${c.awsProfile}`, `account ${c.account ?? 'unknown'}`, `region ${c.region ?? 'from the AWS profile'}`];
  return `${bits.join(', ')}${c.reasons.length ? `. Matches: ${c.reasons.join('; ')}` : ''}`;
}

/** Extra values the wizard asked for when it registers a new profile. */
export interface LinkExtra {
  /** Account to pin when `~/.aws/config` does not say. */
  account?: string | undefined;
  /** Scopes the agent may be granted on this profile (else pf's defaults). */
  scopes?: string[] | undefined;
}

export type LinkResult =
  | { ok: true; name: string; registered: boolean; wroteRepo: boolean }
  | { ok: false; reason: string };

/**
 * Register the candidate when it is new, name it in the repo's `pf.json`, and refresh `ctx`.
 * A repo that cannot be written (no repo, read-only, broken pf.json) still gets the profile for
 * this session: the caller sets `PF_PROFILE` from `name`, and `wroteRepo` says what to tell the user.
 */
export function applyLink(ctx: Context, c: LinkCandidate, extra: LinkExtra = {}): LinkResult {
  let name = c.name;
  let registered = false;
  if (c.kind === 'aws') {
    name = suggestProfileName(c.awsProfile, Object.keys(ctx.user.profiles ?? {}));
    const account = c.account ?? extra.account;
    const ok = saveProfile(name, {
      aws: { profile: c.awsProfile, ...(account ? { account } : {}), ...(c.region ? { region: c.region } : {}) },
      ...(extra.scopes?.length ? { agent: { aws: { scopes: extra.scopes } } } : {}),
    });
    if (!ok) return { ok: false, reason: 'could not write ~/.pf/config.json' };
    registered = true;
  } else if (!ctx.user.profiles?.[name]) {
    return { ok: false, reason: `the profile "${name}" is no longer registered` };
  }
  const wroteRepo = ctx.repo ? linkRepoProfile(ctx.repo.root, name) : false;
  refreshContext(ctx);
  return { ok: true, name, registered, wroteRepo };
}
