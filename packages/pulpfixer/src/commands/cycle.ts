import type { Command } from '@pulpfixer/kit/types';
import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { CYCLE_USAGE, findCheckout, runDevCycle } from '../devcycle.js';

/**
 * `pf c` / `pf cycle`: the dev cycle (`./pf cycle`) for the pulpfixer checkout, also from the global pf.
 * Only works inside the pulpfixer repo; `./pf` handles it before this runs.
 */
function cycleCommand(name: string): Command {
  return {
    name,
    summary: 'Dev cycle in the pulpfixer checkout: bump, commit, publish to staging, push, update pf',
    group: 'Tools',
    hidden: true, // only meaningful in one repo: keep it out of the help everywhere else (the ./pf menu lists it)
    usage: `pf ${name} [--message <msg>] [--no-push] [--yes] [--dry-run]  (only inside the pulpfixer repo)`,
    async run(ctx, args) {
      const root = findCheckout(ctx.workdir);
      if (!root) {
        const c = err();
        process.stderr.write(
          `${badgeLabel('error', c)} pf ${name} only works inside the pulpfixer checkout (it runs ${termLine(CYCLE_USAGE, c)}).\n`,
        );
        return 1;
      }
      return runDevCycle(root, args);
    },
  };
}

export const cycleCommands: Command[] = [cycleCommand('c'), cycleCommand('cycle')];
