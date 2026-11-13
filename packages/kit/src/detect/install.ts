import path from 'node:path';
import type { Context } from '../context.js';
import { readJson } from '../util.js';
import { configStep, workspaceDirs } from './deploy.js';
import { detectLocalCli } from './localcli.js';
import { nodeManager, nodeRun, type Candidate } from './stacks.js';

/**
 * The repo's own install targets: the things `pf install [local|<to>]` runs. A target is named by a
 * script `install:<to>` or `install-<to>` (`install:local` installs the repo on this machine, for example
 * a Cursor extension; `install:cursor` installs it into Cursor). `local:install` is the same as
 * `install:local`. The plain `install` script is never a target: it is the package manager's lifecycle
 * hook, and `pf install` already falls back to the dependency install.
 */
export const LOCAL_TARGET = 'local';

/** The target a script name stands for (`install:cursor` -> `cursor`), or null when it is not one. */
export function installTargetOf(name: string): string | null {
  if (name === 'local:install') return LOCAL_TARGET;
  const m = /^install[:-](.+)$/.exec(name);
  return m ? m[1]! : null;
}

/** `install:<to>` names come before `install-<to>` and `local:install`. */
const byPreference = (a: string, b: string): number => Number(b.startsWith('install:')) - Number(a.startsWith('install:'));

/**
 * Every install target the repo defines, by target name, each with the command that runs it. The
 * first source wins: `pulpfixer.json`, then package.json scripts (root, then workspace packages),
 * composer scripts, the local `./a` CLI.
 */
export function findInstallTargets(ctx: Context): Map<string, Candidate> {
  const root = ctx.repo?.root ?? ctx.workdir;
  const found = new Map<string, Candidate>();
  const put = (target: string | null, cand: () => Candidate) => {
    if (target && !found.has(target)) found.set(target, cand());
  };

  for (const key of Object.keys(ctx.config.commands)) put(installTargetOf(key), () => configStep(ctx, key)!);

  for (const d of workspaceDirs(root)) {
    const pkg = readJson<{ scripts?: Record<string, unknown> }>(d, 'package.json');
    const rel = path.relative(root, d) || '.';
    for (const name of Object.keys(pkg?.scripts ?? {}).sort(byPreference)) {
      put(installTargetOf(name), () => ({
        cmd: { argv: nodeRun(nodeManager(root), name), cwd: d },
        source: `${rel}/package.json script ${name}`,
      }));
    }
  }

  const composer = readJson<{ scripts?: Record<string, unknown> }>(root, 'composer.json');
  for (const name of Object.keys(composer?.scripts ?? {}).sort(byPreference)) {
    put(installTargetOf(name), () => ({ cmd: { argv: ['composer', 'run', name], cwd: root }, source: `composer script ${name}` }));
  }

  const cli = detectLocalCli(root);
  for (const c of [...(cli?.commands ?? [])].sort((a, b) => byPreference(a.name, b.name))) {
    put(installTargetOf(c.name), () => ({ cmd: { argv: [cli!.entry, c.name], cwd: root }, source: `${cli!.entry} ${c.name}` }));
  }

  // `local` first, then the rest in the order found.
  const local = found.get(LOCAL_TARGET);
  return local ? new Map([[LOCAL_TARGET, local], ...[...found].filter(([k]) => k !== LOCAL_TARGET)]) : found;
}

/** The command for `pf install <target>`, or null when the repo defines none. */
export function detectInstall(ctx: Context, target: string): Candidate | null {
  return findInstallTargets(ctx).get(target) ?? null;
}
