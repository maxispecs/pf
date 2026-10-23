import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_NAME, pfHome } from '@pulpfixer/kit/constants';
import { runCmd } from '@pulpfixer/kit/exec';
import { stripRcBlock, RC_START } from '../install/completions.js';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { multiPick } from '@pulpfixer/kit/ui/picker';
import { confirm, reporter } from '@pulpfixer/kit/ui/prompt';
import { termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';

type Part = 'package' | 'shell' | 'data';

export const uninstallCommand: Command = {
  name: 'uninstall',
  summary: 'Remove pf from this machine',
  group: 'Tools',
  usage: 'pf uninstall [--purge] [--no-package] [--no-shell] [--yes] [--dry-run]',
  async run(_ctx, args) {
    const rest = [...args];
    const purge = takeFlag(rest, '--purge');
    const noPackage = takeFlag(rest, '--no-package');
    const noShell = takeFlag(rest, '--no-shell');
    const yes = takeFlag(rest, '--yes', '-y');
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const c = out();
    const r = reporter(c);

    const what: Record<Part, boolean> = { package: !noPackage, shell: !noShell, data: purge };
    if (!yes) {
      if (interactive()) {
        const picked = await multiPick<Part>(
          'What should pf remove?',
          [
            { value: 'package', label: 'pf package', hint: `global ${PACKAGE_NAME} (npm rm -g)` },
            { value: 'shell', label: 'shell completions', hint: 'the pf block in your shell rc, fish completions' },
            { value: 'data', label: 'pf data', hint: `${pfHome()} (config, state, installed plugins and skills)` },
          ],
          { defaults: (Object.keys(what) as Part[]).filter((k) => what[k]) },
        );
        if (!picked || picked.length === 0) {
          r.info('cancelled');
          return 130;
        }
        what.package = picked.includes('package');
        what.shell = picked.includes('shell');
        what.data = picked.includes('data');
        const flags = [!what.package && '--no-package', !what.shell && '--no-shell', what.data && '--purge'].filter(Boolean);
        process.stderr.write(`${err().dim('same without the menu:')} ${termLine(`pf uninstall --yes${flags.length ? ' ' + flags.join(' ') : ''}`, err())}\n`);
      } else if (!(await confirm(`Remove the global ${PACKAGE_NAME} package and the shell completion blocks?`, false, { flag: '--yes' }))) {
        r.info('cancelled');
        return 130;
      }
    }

    // Shell wiring first: it does not need pf itself.
    if (what.shell) {
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
    }

    let code = 0;
    if (what.package) {
      code = await runCmd({ argv: ['npm', 'rm', '-g', PACKAGE_NAME] }, { dryRun });
      if (code !== 0) r.fail('npm rm -g failed. Try it yourself, with sudo if the prefix needs it');
    }

    if (what.data) {
      const dir = pfHome();
      if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
      r.ok(`${dryRun ? 'would delete' : 'deleted'} ${dir}`);
    } else r.info(`${pfHome()} kept (use --purge to delete it)`);
    return code;
  },
};
