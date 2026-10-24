import fs from 'node:fs';
import { artActions, artDirs, ansiFile, BUILTIN_ARTS, cleanAnsi, customArts } from '../art/index.js';
import { renderMascot } from '@pulpfixer/kit/ui/mascot';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, table, termLine } from '@pulpfixer/kit/ui/text';
import type { Command } from '@pulpfixer/kit/types';

/** Pictures that are built into pf and not set per command. */
const FIXED = [{ name: 'lost', what: 'built in', actions: ['unknown command', 'uncaught error'] }];

export const artCommand: Command = {
  name: 'art',
  summary: 'List the pictures pf prints, which commands show them, and where to add your own',
  group: 'Help',
  usage: 'pf art [list | show <name>]',
  async run(_ctx, args) {
    const [sub = 'list', name] = args;
    const c = out();
    const e = err();
    const actions = artActions();
    const custom = customArts();
    if (sub === 'list') {
      const shownBy = (art: string) => Object.entries(actions).filter(([, a]) => a === art).map(([cmd]) => termLine(`pf ${cmd}`, c));
      const rows = [
        ...Object.keys(BUILTIN_ARTS).map((n) => [termLine(n, c), 'built in', shownBy(n).join(c.dim(', ')) || c.dim('no command'), termLine(`pf art show ${n}`, c)]),
        ...Object.entries(custom).map(([n, f]) => [termLine(n, c), f.replace(process.env.HOME ?? '\0', '~'), shownBy(n).join(c.dim(', ')) || c.dim('no command'), termLine(`pf art show ${n}`, c)]),
        ...FIXED.map((f) => [termLine(f.name, c), f.what, f.actions.join(c.dim(', ')), c.dim('shown when it happens')]),
      ];
      process.stdout.write(table(['Picture', 'From', 'Shown by', 'Preview'], rows, c) + '\n');
      const missing = Object.entries(actions).filter(([, a]) => a !== 'none' && !(a in BUILTIN_ARTS) && !(a in custom));
      for (const [cmd, a] of missing) process.stderr.write(`${badgeLabel('warning', e)} pf ${cmd} is set to "${a}", but there is no ${a}.ansi\n`);
      const [mine, shipped] = artDirs();
      process.stdout.write(
        `${c.dim('Add your own: put name.ansi and an art.json in')} ${termLine(mine!.replace(process.env.HOME ?? '\0', '~'), c)}${c.dim(', or in the pf assets folder')} ${shipped}\n` +
          `${c.dim('art.json: {"actions": {"update": "name", "repo": "none"}}. PF_NO_MASCOT=1 turns all pictures off.')}\n`,
      );
      return 0;
    }
    if (sub === 'show') {
      if (name && name in BUILTIN_ARTS) {
        process.stdout.write((renderMascot(BUILTIN_ARTS[name]!, c) || c.dim('(no color: the pictures are color only)')) + '\n');
        return 0;
      }
      const file = name ? ansiFile(name) : null;
      if (file) {
        process.stdout.write(cleanAnsi(fs.readFileSync(file, 'utf8')).join('\n') + '\n');
        return 0;
      }
      if (name === 'lost') {
        process.stderr.write('lost appears only when pf does not know a command or hits an error.\n');
        return 0;
      }
      process.stderr.write(`${badgeLabel('error', e)} unknown picture "${name ?? ''}". Run ${termLine('pf art list', e)}.\n`);
      return 1;
    }
    process.stderr.write(`${badgeLabel('error', e)} usage: pf art [list | show <name>]\n`);
    return 1;
  },
};
