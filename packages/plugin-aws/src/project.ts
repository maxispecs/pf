import type { Context } from '@pulpfixer/kit/context';
import type { Limits } from '@pulpfixer/kit/profiles';
import { resolveProfile, type ResolvedProfile } from '@pulpfixer/kit/profiles';
import type { AwsTarget } from './aws.js';
import { limitsFor } from './access.js';

/** The AWS side of the profile that applies here, ready to use, or why there is none. */
export type ProjectAws =
  | { ok: true; profile: ResolvedProfile; target: AwsTarget & { profile: string }; account?: string; limits: Limits }
  | { ok: false; profile: ResolvedProfile | null; problem: string };

export function projectAws(ctx: Context, flag?: string): ProjectAws {
  const profile = resolveProfile(ctx, flag ? { flag } : {});
  if (!profile) {
    return {
      ok: false,
      profile: null,
      problem: 'No pf profile applies here. Add one with `pf profile add <name>`, then name it in pf.json ("profile": "<name>") or make it the default with `pf profile use <name>`.',
    };
  }
  if (!profile.config) {
    return { ok: false, profile, problem: `The profile "${profile.name}" (from ${profile.source}) is not configured. Add it with \`pf profile add ${profile.name}\`.` };
  }
  const aws = profile.config.aws;
  if (!aws?.profile) {
    return { ok: false, profile, problem: `The profile "${profile.name}" has no AWS profile. Set one with \`pf profile add ${profile.name} --aws-profile <name>\`.` };
  }
  return {
    ok: true,
    profile,
    target: { profile: aws.profile, ...(aws.region ? { region: aws.region } : {}) },
    ...(aws.account ? { account: aws.account } : {}),
    limits: limitsFor(profile.config, ctx.config.agent?.aws),
  };
}

export function describeLimits(l: Limits): string {
  return `scopes ${l.scopes.join(', ') || 'none'}; regions ${l.regions ? l.regions.join(', ') || 'none' : 'any'}; at most ${l.maxTtlMinutes} min`;
}
