import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_NAME, pfHome } from '../constants.js';
import { runCmd } from '../exec.js';
import { stripRcBlock, RC_START } from '../install/completions.js';
import { out } from '../ui/palette.js';
import { confirm, reporter } from '../ui/prompt.js';
import { takeFlag } from '../util.js';
import type { Command } from './types.js';

export const uninstallCommand: Command = {
  name: 'uninstall',
  summary: 'Remove pf from this machine',
  group: 'Tools',
  usage: 'pf uninstall [--purge] [--yes] [--dry-run]',
  async run(_ctx, args) {
    const rest = [...args];
    const purge = takeFlag(rest, '--purge');
    const yes = takeFlag(rest, '--yes', '-y');
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const c = out();
    const r = reporter(c);

    if (!(yes || (await confirm(`Remove the global ${PACKAGE_NAME} package and the shell completion blocks?`, false)))) {
      r.info('cancelled');
      return 130;
    }

    // Shell wiring first: it does not need pf itself.
    const home = os.homedir();
    const rcs = [path.join(process.env.ZDOTDIR ?? home, '.zshrc'), path.join(home, '.bashrc'), path.join(home, '.bash_profile')];
    for (const rc of rcs) {
      try {
        const text = fs.readFileSync(rc, 'utf8');
        if (!text.includes(RC_START)) continue;
        if (dryRun) r.info(`would remove the pf block from ${rc}`);
        else {
          fs.writeFileSync(rc, stripRcBlock(text));
          r.ok(`removed the pf block from ${rc}`);
        }
      } catch {
        // rc missing or unreadable: nothing to do
      }
    }
    const fish = path.join(home, '.config', 'fish', 'completions', 'pf.fish');
    if (fs.existsSync(fish)) {
      if (!dryRun) fs.rmSync(fish, { force: true });
      r.ok(`${dryRun ? 'would remove' : 'removed'} ${fish}`);
    }

    const code = await runCmd({ argv: ['npm', 'rm', '-g', PACKAGE_NAME] }, { dryRun });
    if (code !== 0) r.fail('npm rm -g failed. Try it yourself, with sudo if the prefix needs it');

    if (purge) {
      const dir = pfHome();
      if (await (yes ? Promise.resolve(true) : confirm(`Delete ${dir} (config, state, completions)?`, false))) {
        if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
        r.ok(`${dryRun ? 'would delete' : 'deleted'} ${dir}`);
      }
    } else r.info(`${pfHome()} kept (use --purge to delete it)`);
    return code;
  },
};
