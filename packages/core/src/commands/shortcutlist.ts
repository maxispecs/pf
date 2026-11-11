import { GROUPS, type Command } from '@pulpfixer/kit/types';
import { out, type Palette } from '@pulpfixer/kit/ui/palette';
import { h2, termLine } from '@pulpfixer/kit/ui/text';
import { SHORTCUTS, type Shortcut } from './shortcuts.js';

/** Plain-text padding: measure before painting, so colors never skew the columns. */
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

/** A shortcut matches a filter when the text is in a name, its target, its summary or its group. */
function matches(s: Shortcut, filter: string): boolean {
  const q = filter.toLowerCase();
  return [...s.names, s.target.join(' '), s.summary, s.group].some((x) => x.toLowerCase().includes(q));
}

/**
 * The shortcuts grouped by niche (Agent, Develop, Docs & deploy, ...), in the order of `GROUPS`,
 * as `pf r  pf dev  Run the repo` rows with aligned columns. Pure: returns the lines.
 */
export function shortcutLines(shortcuts: Shortcut[] = SHORTCUTS, c: Palette = out(), filter = ''): string[] {
  const list = filter ? shortcuts.filter((s) => matches(s, filter)) : shortcuts;
  if (!list.length) return [];
  const short = (s: Shortcut) => s.names.map((n) => `pf ${n}`).join(', ');
  const full = (s: Shortcut) => `pf ${s.target.join(' ')}`;
  const shortW = Math.max(...list.map((s) => short(s).length));
  const fullW = Math.max(...list.map((s) => full(s).length));
  const lines: string[] = [];
  for (const g of GROUPS) {
    const inGroup = list.filter((s) => s.group === g);
    if (!inGroup.length) continue;
    if (lines.length) lines.push('');
    lines.push(h2(g, c));
    for (const s of inGroup) {
      // Several names for one target are listed together: `pf up, pf put`.
      const names = s.names.map((n) => termLine(`pf ${n}`, c)).join(c.dim(', '));
      const gap = ' '.repeat(shortW - short(s).length);
      lines.push(`  ${names}${gap}  ${c.dim('=')} ${termLine(full(s), c)}${' '.repeat(fullW - full(s).length)}  ${s.summary}`);
    }
  }
  return lines;
}

export const shortcutsCommand: Command = {
  name: 'shortcuts',
  summary: 'List the shortcuts (pf s), grouped by what they are for',
  group: 'Help',
  usage: 'pf shortcuts [filter]',
  async run(_ctx, args) {
    const c = out();
    const filter = args.filter((a) => !a.startsWith('-')).join(' ');
    const lines = shortcutLines(SHORTCUTS, c, filter);
    const w = (s: string) => process.stdout.write(s + '\n');
    if (!lines.length) {
      w(`No shortcut matches "${filter}". ${termLine('pf shortcuts', c)} lists them all.`);
      return 1;
    }
    w(`${c.bold('Shortcuts')}  ${c.dim('a short name for a full command; extra args pass through:')} ${termLine('pf ds --dry-run', c)}\n`);
    for (const l of lines) w(l);
    w(`\n${termLine('pf help', c)} ${c.dim('shows every command and option.')}`);
    return 0;
  },
};
