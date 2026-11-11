import path from 'node:path';
import { loadRepoConfig, loadUserConfig, type RepoConfig, type UserConfig } from './config.js';
import { findRepo, hasProjectMarker, type Repo } from './detect/repo.js';
import { detectStacks, type StackInfo } from './detect/stacks.js';
import { version } from './version.js';

export interface Context {
  cwd: string;
  repo: Repo | null;
  /** Where commands run: `cwd` when it is a project inside the repo, otherwise the repo root. */
  workdir: string;
  stacks: StackInfo[];
  config: RepoConfig;
  user: UserConfig;
  version: string;
}

/**
 * Re-read `pulpfixer.json` and `~/.pf/config.json` into a context that is already built. A long-running
 * agent session calls this before each tool, so a profile linked or edited mid-session applies at once.
 */
export function refreshContext(ctx: Context): void {
  ctx.user = loadUserConfig();
  if (ctx.repo) ctx.config = loadRepoConfig(ctx.repo.root);
}

export function buildContext(cwd: string = process.cwd()): Context {
  const repo = findRepo(cwd);
  let workdir = repo?.root ?? path.resolve(cwd);
  if (repo && path.resolve(cwd) !== repo.root && hasProjectMarker(path.resolve(cwd))) {
    workdir = path.resolve(cwd);
  }
  return {
    cwd: path.resolve(cwd),
    repo,
    workdir,
    stacks: repo ? detectStacks(workdir) : [],
    config: repo ? loadRepoConfig(repo.root) : { commands: {} },
    user: loadUserConfig(),
    version: version(),
  };
}
