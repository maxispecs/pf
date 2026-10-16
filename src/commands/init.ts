import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../context.js';
import { detectDocs } from '../detect/docs.js';
import { candidates } from '../detect/resolve.js';
import { TASKS, type Task } from '../detect/stacks.js';
import { runCmd, type Cmd } from '../exec.js';
import { err } from '../ui/palette.js';
import { confirm } from '../ui/prompt.js';
import { quote, readJson, takeFlag } from '../util.js';
import { bundledVerCli, findVersionsRoot } from './ver.js';
import type { Command } from './types.js';

interface Entry {
  run: string;
  description?: string;
  group?: string;
  cwd?: string;
}

const DESCRIPTIONS: Record<string, { description: string; group: string }> = {
  dev: { description: 'Run the app locally', group: 'Develop' },
  install: { description: 'Install dependencies', group: 'Develop' },
  build: { description: 'Build the project', group: 'Build & check' },
  test: { description: 'Run the tests', group: 'Build & check' },
  lint: { description: 'Lint the code', group: 'Build & check' },
  doc: { description: 'Run the docs site locally', group: 'Docs & deploy' },
};

/** A command as a pf.json entry: a shell line plus a cwd relative to the repo root when it differs. */
export function toEntry(cmd: Cmd, root: string, name: string): Entry {
  const run = cmd.shell ? cmd.argv[0]! : cmd.argv.map(quote).join(' ');
  const rel = cmd.cwd ? path.relative(root, cmd.cwd) : '';
  return { run, ...DESCRIPTIONS[name], ...(rel ? { cwd: rel } : {}) };
}

/** Build the commands to write: the first detected command per task, without replacing existing entries. */
export function detectedEntries(ctx: Context, existing: Record<string, unknown>): Record<string, Entry> {
  const root = ctx.repo!.root;
  const found: Record<string, Entry> = {};
  for (const task of TASKS as Task[]) {
    if (task in existing) continue;
    const first = candidates(task, ctx)[0];
    if (first) found[task] = toEntry(first.cmd, root, task);
  }
  if (!('doc' in existing)) {
    const first = detectDocs(ctx)[0];
    if (first) found.doc = toEntry(first.cmd, root, 'doc');
  }
  return found;
}

export const initCommand: Command = {
  name: 'init',
  summary: 'Set up this repo for pf (writes pf.json)',
  group: 'Tools',
  usage: 'pf init [--dry-run] [--ver]',
  async run(ctx, args) {
    const c = err();
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const withVer = takeFlag(rest, '--ver');
    if (!ctx.repo) {
      process.stderr.write(`${c.red('error:')} pf init needs a repo. Run it inside a project directory.\n`);
      return 1;
    }
    const root = ctx.repo.root;
    const file = path.join(root, 'pf.json');
    const existing = readJson<{ name?: string; commands?: Record<string, unknown> }>(root, 'pf.json') ?? {};
    const commands = { ...(existing.commands ?? {}) };
    const added = detectedEntries(ctx, commands);
    const next = { ...existing, name: existing.name ?? ctx.repo.name, commands: { ...commands, ...added } };

    const names = Object.keys(added);
    if (names.length === 0) process.stderr.write(c.dim('nothing new detected for pf.json\n'));
    for (const n of names) process.stderr.write(`  ${c.green('+')} ${c.bold(n.padEnd(8))} ${added[n]!.run}${added[n]!.cwd ? c.dim(`  (in ${added[n]!.cwd})`) : ''}\n`);

    if (dryRun) process.stderr.write(c.dim(`would write ${file}\n`));
    else if (names.length > 0 || !fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
      process.stderr.write(`${c.green('✔')} wrote ${path.relative(ctx.cwd, file) || 'pf.json'} ${c.dim('(edit it to change what pf runs; nothing is committed)')}\n`);
    }

    if (!findVersionsRoot(ctx.cwd)) {
      const doIt = withVer || (await confirm('Set up major.minor versioning too (pf ver init)?', false, { flag: '--ver' }));
      if (doIt) {
        const code = await runCmd(
          { argv: [process.execPath, bundledVerCli(), 'init', '--root', root, ...(dryRun ? ['--dry-run'] : [])], cwd: root },
          { quiet: true },
        );
        if (code !== 0) return code;
      } else process.stderr.write(c.dim('versioning not set up: run pf ver init when you want it\n'));
    }
    return 0;
  },
};
