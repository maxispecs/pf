import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../context.js';
import { runCmd } from '../exec.js';
import { err } from '../ui/palette.js';
import { badgeLabel, termLine } from '../ui/text.js';
import { confirm } from '../ui/prompt.js';
import { exists } from '../util.js';
import { packageRoot } from '../version.js';
import type { Command } from './types.js';

/** Path of the /ver CLI bundled with pf. */
export function bundledVerCli(): string {
  return path.join(packageRoot(), 'assets', 'version.mjs');
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
    const cli = bundledVerCli();
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
