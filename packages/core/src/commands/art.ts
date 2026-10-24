import { renderMascot, type MascotName } from '@pulpfixer/kit/ui/mascot';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { table } from '@pulpfixer/kit/ui/text';
import { err, out } from '@pulpfixer/kit/ui/palette';
import type { Command } from '@pulpfixer/kit/types';

export interface Art {
  name: string;
  what: string;
  /** Commands or events that print it. */
  actions: string[];
  /** Name for `pf art show`; the pictures without one only appear when their event happens. */
  mascot?: MascotName;
}

/** Every picture pf can print and what triggers it. */
export const ARTS: Art[] = [
  { name: 'octopus-repo', what: 'octopus with a folder', actions: ['pf repo', 'pf r'], mascot: 'repo' },
  { name: 'octopus-update', what: 'octopus with an up arrow', actions: ['pf update'], mascot: 'update' },
  { name: 'octopus-agent', what: 'octopus with robot eyes and an antenna', actions: ['pf agent'], mascot: 'agent' },
  { name: 'lost', what: 'confused figure for when pf is lost', actions: ['unknown command', 'uncaught error'] },
];

export const artCommand: Command = {
  name: 'art',
  summary: 'List the pictures pf prints and which commands show them',
  group: 'Help',
  usage: 'pf art [list | show <name>]',
  async run(_ctx, args) {
    const [sub = 'list', name] = args;
    const c = out();
    if (sub === 'list') {
      const rows = ARTS.map((a) => [termLine(a.name, c), a.what, a.actions.map((x) => termLine(x, c)).join(c.dim(', ')), a.mascot ? termLine(`pf art show ${a.name}`, c) : c.dim('shown when it happens')]);
      process.stdout.write(table(['Picture', 'What', 'Shown by', 'Preview'], rows, c) + '\n');
      process.stdout.write(c.dim('Turn them off with PF_NO_MASCOT=1 (octopus) or PF_NO_TRAVOLTA=1 (all pictures). Force the block style with PF_TRAVOLTA_BLOCKS=half|quadrant.') + '\n');
      return 0;
    }
    if (sub === 'show') {
      const art = ARTS.find((a) => a.name === name);
      const e = err();
      if (!art) {
        process.stderr.write(`${badgeLabel('error', e)} unknown picture "${name ?? ''}". Run ${termLine('pf art list', e)}.\n`);
        return 1;
      }
      if (!art.mascot) {
        process.stderr.write(`${art.name} appears only when it happens: ${art.actions.join(', ')}.\n`);
        return 0;
      }
      process.stdout.write(renderMascot(art.mascot, c) || c.dim('(no color: the pictures are color only)')) ;
      process.stdout.write('\n');
      return 0;
    }
    process.stderr.write(`${badgeLabel('error', err())} usage: ${art_usage}\n`);
    return 1;
  },
};
const art_usage = 'pf art [list | show <name>]';
