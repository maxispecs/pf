import fs from 'node:fs';
import path from 'node:path';
import { runDoc } from './commands/doc.js';
import type { Entry } from '@pulpfixer/kit/types';
import { updateCommand } from './commands/update.js';
import { findVersionsRoot, verCommand } from './commands/ver.js';
import { buildContext, type Context } from '@pulpfixer/kit/context';
import { detectDocs } from '@pulpfixer/kit/detect/docs';
import { formatCmd, runCmd } from '@pulpfixer/kit/exec';
import { runDevCycle } from './devcycle.js';
import { runMenu } from './menu.js';

/**
 * The checkout `./pf` was started from, or null when pf runs as the installed binary.
 * The `pf` launcher in the repo root sets `PF_LOCAL` to its own directory.
 */
export function localRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.PF_LOCAL;
  if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) return null;
  return path.resolve(dir);
}

/** Menu for working on pf itself: manage the global install, docs, versions. */
export function localEntries(root: string, ctx: Context = buildContext(root)): Entry[] {
  const docs = detectDocs(ctx);
  return [
    {
      name: 'cycle',
      summary: 'Dev cycle: bump versions, commit, publish to staging, update the global pf',
      group: 'Global pf',
      detail: 'bump if changed, commit, pnpm publish:cellars, pf u; asks first',
      cli: './pf cycle',
      run: () => runDevCycle(root),
    },
    {
      name: 'install',
      summary: 'Install pf globally from this checkout',
      group: 'Global pf',
      detail: 'build, pack the packages, then npm install -g',
      cli: 'pnpm install:local',
      run: () => runCmd({ argv: ['bash', path.join(root, 'packages', 'core', 'scripts', 'install.sh'), '--from-source'], cwd: root }, { base: root }),
    },
    {
      name: 'update',
      summary: 'Update the global pf from the cellars registry',
      group: 'Global pf',
      detail: 'asks before installing',
      cli: 'pf update',
      run: () => updateCommand.run(ctx, []),
    },
    {
      name: 'doc',
      summary: 'Run the docs site locally',
      group: 'This repo',
      detail: docs[0] ? formatCmd(docs[0].cmd, ctx.workdir) : 'no docs site in this repo yet',
      cli: 'pf docs',
      run: () => runDoc(ctx, { pick: true }),
    },
    {
      name: 'ver',
      summary: 'List versions and bump them (major.minor)',
      group: 'This repo',
      detail: findVersionsRoot(root) ? 'versions.json' : 'not set up yet',
      cli: 'pf ver',
      run: () => verCommand.run(ctx, []),
    },
  ];
}

/** `./pf` with no command: the menu for this checkout. */
export function runLocalMenu(root: string): Promise<number> {
  const ctx = buildContext(root);
  return runMenu(ctx, {
    entries: localEntries(root, ctx),
    title: 'pf from source. What do you want to do?',
    heading: `${ctx.repo?.name ?? path.basename(root)}  (local checkout, ./pf)`,
    historyKey: `local:${root}`,
  });
}
