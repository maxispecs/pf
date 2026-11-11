import path from 'node:path';
import { hasRepoConfig, repoConfigPath } from '../config.js';
import { exists, readJson, listDir } from '../util.js';

export interface Repo {
  root: string;
  name: string;
  hasGit: boolean;
  hasConfig: boolean;
}

/** Files whose presence marks a directory as a project even without git. */
const MARKERS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs', 'Package.swift',
  'Makefile', 'justfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml',
];

export function hasProjectMarker(dir: string): boolean {
  if (MARKERS.some((m) => exists(dir, m))) return true;
  return listDir(dir).some((f) => /\.(sln|slnx|csproj|fsproj)$/.test(f));
}

/** Nearest ancestor with `.git` or a repo config (`pulpfixer.json`, legacy `pf.json`); failing that, `cwd` itself when it looks like a project. */
export function findRepo(cwd: string): Repo | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const hasGit = exists(dir, '.git');
    const hasConfig = hasRepoConfig(dir);
    if (hasGit || hasConfig) return makeRepo(dir, hasGit, hasConfig);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const start = path.resolve(cwd);
  return hasProjectMarker(start) ? makeRepo(start, false, false) : null;
}

function makeRepo(root: string, hasGit: boolean, hasConfig: boolean): Repo {
  const pkgName = readJson<{ name?: string }>(root, 'package.json')?.name;
  const cfgName = readJson<{ name?: string }>(repoConfigPath(root))?.name;
  const name = cfgName ?? (typeof pkgName === 'string' ? pkgName.replace(/^@[^/]+\//, '') : path.basename(root));
  return { root, name, hasGit, hasConfig };
}
