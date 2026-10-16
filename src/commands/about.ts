import { PACKAGE_NAME, REGISTRY_URL, pfHome } from '../constants.js';
import { out } from '../ui/palette.js';
import { displayVersion, packageRoot, version } from '../version.js';
import type { Command } from './types.js';

export const aboutCommand: Command = {
  name: 'about',
  summary: 'About pf',
  group: 'Help',
  usage: 'pf about',
  async run(ctx) {
    const c = out();
    // The big logo is printed with the banner (stderr, terminal only), so this is just the facts.
    const rows: [string, string][] = [
      ['version', `${displayVersion()} (${version()})`],
      ['package', PACKAGE_NAME],
      ['registry', REGISTRY_URL],
      ['node', process.versions.node],
      ['installed at', packageRoot()],
      ['state', pfHome()],
      ['repo', ctx.repo ? `${ctx.repo.name} (${ctx.repo.root})` : 'not inside a repo'],
    ];
    const w = Math.max(...rows.map(([k]) => k.length));
    process.stdout.write('\n');
    process.stdout.write(`  ${c.boldBrand('pulpfixer')}  ${c.dim('(pf)')}\n\n`);
    for (const [k, v] of rows) process.stdout.write(`  ${c.dim(k.padEnd(w))}  ${v}\n`);
    process.stdout.write(`\n  ${c.dim('Run')} ${c.bold('pf help')} ${c.dim('for commands, or')} ${c.bold('pf')} ${c.dim('for the menu.')}\n\n`);
    return 0;
  },
};
