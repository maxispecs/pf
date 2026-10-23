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
