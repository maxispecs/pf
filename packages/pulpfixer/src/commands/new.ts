import fs from 'node:fs';
import path from 'node:path';
import { buildContext } from '@pulpfixer/kit/context';
import { runCmd } from '@pulpfixer/kit/exec';
import { reposDir, shortHome } from '@pulpfixer/kit/suite-settings';
import type { Command } from '@pulpfixer/kit/types';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { ask } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, h2, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption, which } from '@pulpfixer/kit/util';
import { applyTemplate, insideGitRepo, shellPath, templateTarget } from './template.js';
import { repoCommand } from './repo.js';

/**
 * `pf new`: start something new, from a menu.
 *
 *   pf new                    menu: query package, pipe package, empty scratch
 *   pf new query [<name>]     a query package repo (`pf template apply query-package`)
 *   pf new pipe [<name>]      a pipe package repo (`pf template apply pipe-package`)
 *   pf new scratch [<name>]   an empty scratch repo in the suite's repos folder
 *
 * The first two hand every other argument to `pf template apply`; a scratch repo is a folder, `git init`
 * and `pf repo --no-deploy`, nothing else.
 */

const USAGE = `Usage:
  pf new                                   menu: a new query package, pipe package or empty scratch
  pf new query [<name>] [<template flags>]   a query package repo (pf template apply query-package)
  pf new pipe  [<name>] [<template flags>]   a pipe package repo (pf template apply pipe-package)
  pf new scratch [<name>] [--dir <path>] [--dry-run] [--no-git] [--no-repo]
                                           an empty repo to try things in, in the repos folder
                                           (pf suite config, ~/dev by default) or in --dir`;

export type NewKind = 'query' | 'pipe' | 'scratch';

/** What `pf new` can make, as the menu shows it. */
export const NEW_KINDS: { kind: NewKind; label: string; hint: string }[] = [
  { kind: 'query', label: 'Query package', hint: 'a repo of named database queries (@pulpfixer/query-<name>)' },
  { kind: 'pipe', label: 'Pipe package', hint: 'a repo of scripted IO, like db to csv (@pulpfixer/pipe-<name>)' },
  { kind: 'scratch', label: 'Empty scratch', hint: 'an empty repo to try things in' },
];

/** The template a kind is made from, or null for a scratch repo. */
export const templateOfKind = (kind: NewKind): string | null => (kind === 'query' ? 'query-package' : kind === 'pipe' ? 'pipe-package' : null);

const SCRATCH_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Why a scratch name cannot be used, or null. */
export function scratchNameProblem(name: string): string | null {
  return SCRATCH_NAME.test(name) ? null : `"${name}" is not a usable name (lowercase letters, digits and dashes, starting with a letter or digit)`;
}

/** A name to offer for a new scratch repo: `scratch-YYYYMMDD`. */
export function defaultScratchName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `scratch-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

const fail = (msg: string, code = 1): number => {
  process.stderr.write(`${badgeLabel('error', err())} ${msg}\n`);
  return code;
};

/** Tell the user how to repeat a menu step without the menu. */
const sameWithout = (cmd: string): void => {
  const c = err();
  process.stderr.write(`${c.dim('same without the menu:')} ${termLine(cmd, c)}\n`);
};

async function newScratch(cwd: string, args: string[]): Promise<number> {
  const c = err();
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const noGit = takeFlag(rest, '--no-git');
  const noRepo = takeFlag(rest, '--no-repo');
  const dirOpt = takeOption(rest, '--dir');
  let name = rest[0] !== undefined && !rest[0].startsWith('-') ? rest.shift() : undefined;
  if (rest.length) return fail(`unexpected ${rest.join(' ')}\n  ${c.dim('usage')} ${termLine('pf new scratch [<name>] [--dir <path>] [--dry-run] [--no-git] [--no-repo]', c)}`, 2);

  if (name === undefined) {
    if (!(process.stdin.isTTY && process.stderr.isTTY)) return fail(`name the scratch repo: ${termLine('pf new scratch <name>', c)}`, 2);
    const asked = await ask('Scratch name', { initial: defaultScratchName(), validate: (v) => scratchNameProblem(v.trim()) });
    if (asked === null) return (process.stderr.write(c.dim('cancelled, nothing was written\n')), 130);
    name = asked.trim();
  }
  const bad = scratchNameProblem(name);
  if (bad) return fail(bad, 2);

  const base = reposDir();
  if (!dirOpt && fs.existsSync(base) && !fs.statSync(base).isDirectory()) {
    return fail(`the repos folder ${shortHome(base)} is not a folder: change it with pf suite config set reposDir <folder>, or give --dir`);
  }
  const target = templateTarget({ cwd, dirOpt, dir: name, reposDir: base });
  const rel = dirOpt ? path.relative(cwd, target) || '.' : shortHome(target);
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
    return fail(`${rel} already exists and is not empty. Nothing was written: pick another name or --dir.`);
  }

  process.stderr.write(`${h2(`${dryRun ? 'Would create' : 'Creating'} ${rel}`, c)}\n`);
  if (!dryRun) fs.mkdirSync(target, { recursive: true });

  if (!noGit) {
    if (!which('git')) process.stderr.write(`${badgeLabel('warning', c)} git is not on PATH: the folder is not a git repo yet\n`);
    else if (insideGitRepo(target)) process.stderr.write(c.dim('already inside a git repo, no git init\n'));
    else {
      const code = await runCmd({ argv: ['git', 'init', '--quiet'], cwd: target }, { dryRun, base: cwd });
      if (code !== 0) return code;
    }
  }

  if (!noRepo) {
    if (dryRun) process.stderr.write(`${c.dim('would run')} ${termLine(`pf repo --no-deploy  (in ${rel})`, c)}\n`);
    else {
      process.stderr.write('\n');
      const code = await repoCommand.run(buildContext(target), ['--no-deploy']);
      if (code !== 0) return code;
    }
  }

  if (dryRun) process.stderr.write(c.dim(`\ndry run: nothing was written to ${rel}\n`));
  else process.stderr.write(`\n${c.dim('Next:')}\n  ${termLine(`cd ${dirOpt ? rel : shellPath(target)}`, c)}\n`);
  return 0;
}

/** Make one kind of thing; `args` are what followed its name on the command line. */
export function makeNew(cwd: string, kind: NewKind, args: string[]): Promise<number> {
  const template = templateOfKind(kind);
  return template ? applyTemplate(cwd, [template, ...args]) : newScratch(cwd, args);
}

async function menu(cwd: string): Promise<number> {
  const kind = await pick<NewKind>('New', NEW_KINDS.map((k) => ({ value: k.kind, label: k.label, hint: k.hint })), { search: false });
  if (!kind) return 130;
  sameWithout(`pf new ${kind}`);
  return makeNew(cwd, kind, []);
}

export const newCommand: Command = {
  name: 'new',
  summary: 'Start a new query package, pipe package or empty scratch repo',
  group: 'Tools',
  usage: 'pf new [query|pipe|scratch] [<name>] [--dir <path>] [--dry-run] [--no-git] [--no-repo]',
  async run(ctx, args) {
    const [sub, ...rest] = args;
    if (!sub) {
      if (interactive()) return menu(ctx.cwd);
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    if (sub === 'help' || sub === '--help' || sub === '-h') return (process.stdout.write(`${USAGE}\n`), 0);
    const kind = NEW_KINDS.find((k) => k.kind === sub)?.kind;
    if (!kind) {
      process.stderr.write(`${badgeLabel('error', err())} unknown kind "${sub}"\n${USAGE}\n`);
      return 2;
    }
    return makeNew(ctx.cwd, kind, rest);
  },
};
