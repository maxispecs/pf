import type { GitPushConfig } from '@pulpfixer/kit/local-state';

/**
 * Pure planning for `pf git push`: which remotes get pushed, in which order, with which args.
 * Nothing here runs git; the command gathers the facts and executes the steps.
 */

export interface PushFacts {
  config: GitPushConfig;
  /** Current branch, null on a detached HEAD. */
  branch: string | null;
  /** `branch.<name>.remote` (`.` for a branch that tracks a local one); undefined when the branch has no upstream. */
  upstreamRemote?: string | undefined;
  /** Every remote the repo has (`git remote`). */
  remotes: string[];
  /** Arguments after pf's own flags; passed to every `git push`. */
  args: string[];
  /** Push the secondary remotes too (false for `--no-secondary`). */
  secondary: boolean;
}

export interface PushStep {
  remote: string;
  role: 'primary' | 'secondary';
  /** The `git push` argv, after `git`. */
  argv: string[];
}

export type PushPlan = { ok: true; primary: string; steps: PushStep[] } | { ok: false; error: string };

/**
 * The remote `pf git push` pushes to first: the configured one, else the branch's upstream remote, else `origin`.
 * With the repo's `remotes` it also recognises a primary that is not named `origin`: when there is no `origin`,
 * the one remote that is not a backup is the primary. (Without `remotes` the answer is `origin`, the default.)
 */
export function resolvePrimary(config: GitPushConfig, upstreamRemote?: string, remotes?: string[]): string {
  if (config.primary) return config.primary;
  if (upstreamRemote && upstreamRemote !== '.') return upstreamRemote;
  if (remotes && !remotes.includes('origin')) {
    const backups = new Set(config.secondary ?? []);
    const candidates = remotes.filter((r) => !backups.has(r));
    if (candidates.length === 1) return candidates[0]!;
  }
  return 'origin';
}

const SET_UPSTREAM = new Set(['-u', '--set-upstream']);

/** `-u` is for the primary only: on a secondary it would move the branch's upstream away from it. */
export function secondaryArgs(args: string[]): string[] {
  return args.filter((a) => !SET_UPSTREAM.has(a));
}

/** Does the user name a refspec (or remote) of their own? Then a detached HEAD is fine. */
const hasRefspec = (args: string[]): boolean => args.some((a) => !a.startsWith('-'));

export function planPush(f: PushFacts): PushPlan {
  if (f.branch === null && !hasRefspec(f.args)) {
    return { ok: false, error: 'HEAD is detached, so there is no branch to push. Check out a branch, or name what to push: pf gp HEAD:refs/heads/<branch>' };
  }
  const primary = resolvePrimary(f.config, f.upstreamRemote, f.remotes);
  const known = new Set(f.remotes);
  if (!known.has(primary)) {
    const hint = f.config.primary
      ? `the primary remote in .pf/config.json is "${primary}". Change it with pf git primary <remote>, or add it with pf git primary ${primary} <url>`
      : f.remotes.length
        ? `this repo has no primary remote yet. Pick one with pf git primary <remote> (this repo has: ${f.remotes.join(', ')}), or add one with pf git primary origin <url>`
        : 'this repo has no remote yet. Add the primary with pf git primary origin <url>';
    return { ok: false, error: `no git remote named "${primary}": ${hint}` };
  }
  const secondaries = f.secondary ? (f.config.secondary ?? []).filter((r) => r !== primary) : [];
  const missing = secondaries.filter((r) => !known.has(r));
  if (missing.length) {
    return {
      ok: false,
      error: `backup remote${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} ${missing.length > 1 ? 'are' : 'is'} configured but missing from git. Add ${missing.length > 1 ? 'them' : 'it'} with pf git backup add <remote> <url>, or drop ${missing.length > 1 ? 'them' : 'it'} with pf git backup remove <remote>`,
    };
  }
  // A branch with no upstream (its first push) fails a plain `git push <remote>` when the remote is the default
  // one, even with -u, so the primary push names HEAD and sets the upstream. Not when the user names a refspec.
  const firstPush = f.branch !== null && f.upstreamRemote === undefined && !hasRefspec(f.args);
  const withUpstream = f.args.some((a) => SET_UPSTREAM.has(a)) ? [] : ['-u'];
  return {
    ok: true,
    primary,
    steps: [
      { remote: primary, role: 'primary', argv: firstPush ? ['push', primary, ...withUpstream, 'HEAD', ...f.args] : ['push', primary, ...f.args] },
      ...secondaries.map((r): PushStep => ({ remote: r, role: 'secondary', argv: ['push', r, ...secondaryArgs(f.args)] })),
    ],
  };
}
