import type { Context } from '@pulpfixer/kit/context';
import { findInstallTargets } from '@pulpfixer/kit/detect/install';
import { formatCmd, runCmd, withArgs } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, splitDashes, takeFlag } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';
import { runTask } from './tasks.js';

export interface InstallOptions {
  dryRun?: boolean;
  pick?: boolean;
  /** Skip the repo's install targets and install dependencies. */
  deps?: boolean;
  extra?: string[];
}

function noTarget(ctx: Context, target: string): string {
  const c = err();
  const known = [...findInstallTargets(ctx).keys()];
  return (
    `${badgeLabel('error', c)} no ${c.bold(`install:${target}`)} target found for this repo.\n` +
    (known.length ? `${c.dim('this repo has:')} ${known.map((k) => termLine(`pf install ${k}`, c)).join(', ')}\n` : '') +
    `Add a ${c.bold(`install:${target}`)} script to package.json, or to ${c.bold('pulpfixer.json')}: { "commands": { "install:${target}": { "run": "<your command>" } } }\n`
  );
}

/**
 * `pf install [local|<to>]`. A target runs the repo's own `install:<to>` script. With no target it runs
 * a `pulpfixer.json` `install` entry, else `install:local`, else the only `install:*` target (several: pick),
 * else the dependency install of the stack.
 */
export async function runInstall(ctx: Context, target: string | undefined, opts: InstallOptions = {}): Promise<number> {
  const c = err();
  if (!ctx.repo) {
    process.stderr.write(`${badgeLabel('error', c)} pf install needs a repo. Run it inside a project directory.\n`);
    return 1;
  }
  const dependencies = () => runTask(ctx, 'install', { dryRun: opts.dryRun, pick: opts.pick, extra: opts.extra });
  if (opts.deps) return dependencies();

  const targets = findInstallTargets(ctx);
  let name = target;
  if (!name) {
    if (ctx.config.commands.install) return dependencies(); // an explicit `install` entry wins
    if (targets.size === 0) return dependencies();
    if (targets.has('local') || targets.size === 1) name = targets.has('local') ? 'local' : [...targets.keys()][0]!;
    else if (interactive()) {
      const chosen = await pick(
        'Install which target?',
        [...targets].map(([k, cand]) => ({ value: k, label: k, hint: cand.source, detail: formatCmd(cand.cmd, ctx.repo!.root) })),
      );
      if (!chosen) return 130;
      name = chosen;
    } else {
      process.stderr.write(
        `${badgeLabel('error', c)} several install targets: ${[...targets.keys()].join(', ')}.\n` +
          `Pick one, for example ${termLine(`pf install ${[...targets.keys()][0]}`, c)}.\n`,
      );
      return 2;
    }
  }

  const cand = targets.get(name);
  if (!cand) {
    process.stderr.write(noTarget(ctx, name));
    return 1;
  }
  process.stderr.write(`${c.bold(`Install ${name}`)} ${c.dim(cand.source)}\n`);
  return runCmd(withArgs(cand.cmd, opts.extra ?? []), { dryRun: opts.dryRun, base: ctx.repo.root });
}

/** `pf install [local|<to>] [--deps] [--dry-run] [--pick] [-- <args>]` */
export function parseInstallArgs(args: string[]): { target?: string; options: InstallOptions; bad?: string } {
  const [before, after] = splitDashes([...args]);
  const dryRun = takeFlag(before, '--dry-run', '-n');
  const pickFlag = takeFlag(before, '--pick', '-p');
  const deps = takeFlag(before, '--deps');
  const bad = before.find((a) => a.startsWith('-'));
  const target = before.find((a) => !a.startsWith('-'));
  return {
    ...(target ? { target } : {}),
    options: { dryRun, pick: pickFlag, deps, extra: after },
    ...(bad ? { bad } : {}),
  };
}

export const installCommand: Command = {
  name: 'install',
  summary: 'Install: the repo\'s install target (install:local, install:<to>), else dependencies',
  group: 'Develop',
  usage: 'pf install [local|<to>] [--deps] [--dry-run] [--pick] [-- <args>]',
  async run(ctx, args) {
    const parsed = parseInstallArgs(args);
    if (parsed.bad) {
      process.stderr.write(`${badgeLabel('error', err())} unknown option ${parsed.bad}\n${err().dim('usage:')} ${termLine(installCommand.usage, err())}\n`);
      return 2;
    }
    return runInstall(ctx, parsed.target, parsed.options);
  },
};
