import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '@pulpfixer/kit/context';
import { runCmd } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { exists } from '@pulpfixer/kit/util';
import { packageRoot } from '@pulpfixer/kit/version';
import { homeSkillFile } from '../skills/stack.js';
import type { Command } from '@pulpfixer/kit/types';

/** Path of the /ver CLI bundled with pf (the offline fallback, see resolveVerCli). */
export function bundledVerCli(): string {
  return path.join(packageRoot(), 'assets', 'version.mjs');
}

/**
 * The /ver CLI pf runs and copies into repos: the newest of the `ver` skill in pf's own folder
 * (kept current by `pf update`) and the copy bundled with pf. A tie goes to the skill's copy.
 */
export function resolveVerCli(skillsDir?: string): string {
  const bundled = bundledVerCli();
  const home = homeSkillFile('ver', path.join('scripts', 'version.mjs'), skillsDir);
  return home && cliRevision(home) >= cliRevision(bundled) ? home : bundled;
}

/** Nearest ancestor of `from` holding a versions.json. */
export function findVersionsRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (exists(dir, 'versions.json')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Revision integer of a ver CLI copy (`--cli-version`); 0 when the copy predates the flag. */
export function cliRevision(file: string): number {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /const CLI_VERSION = (\d+);/.exec(text);
    return m ? parseInt(m[1]!, 10) : 0;
  } catch {
    return 0;
  }
}

export const verCommand: Command = {
  name: 'ver',
  summary: 'List versions and bump them (major.minor)',
  group: 'Tools',
  usage: 'pf ver [list|bump <target> <major|minor>|init|sync] [--dry-run]',
  async run(ctx: Context, args: string[]) {
    const c = err();
    const cli = resolveVerCli();
    if (!fs.existsSync(cli)) {
      process.stderr.write(`${badgeLabel('error', c)} the bundled ver CLI is missing (${cli}). Reinstall pf.\n`);
      return 1;
    }
    const first = args[0];
    const known = findVersionsRoot(ctx.cwd);
    const repoRoot = ctx.repo?.root ?? ctx.cwd;
    const run = (a: string[]) => runCmd({ argv: [process.execPath, cli, ...a], cwd: ctx.cwd }, { quiet: true });

    if (!known && (!first || first === 'list')) {
      process.stderr.write(`${badgeLabel('warning', c)} no versions.json in ${c.bold(path.relative(ctx.cwd, repoRoot) || '.')} or above, so versioning is not set up.\n`);
      if (await confirm('Set it up now (pf ver init)?', false)) return run(['init', '--root', repoRoot]);
      process.stderr.write(`${c.dim('Run')} ${termLine('pf ver init', c)} ${c.dim('to set it up. It never commits.')}\n`);
      return 1;
    }

    const full = [...args];
    if (!full.includes('--root') && !full.includes('-h') && !full.includes('--help') && !full.includes('--cli-version')) {
      full.push('--root', first === 'init' ? repoRoot : (known ?? repoRoot));
    }
    return run(full);
  },
};
