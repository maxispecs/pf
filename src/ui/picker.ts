import readline from 'node:readline';
import { out, stripAnsi } from './palette.js';

export interface PickItem<T> {
  value: T;
  label: string;
  hint?: string;
  group?: string;
}

export interface PickOptions {
  /** Type to filter (disables j/k/q shortcuts). */
  search?: boolean;
  footer?: string;
}

type Row<T> = { header: string } | { item: PickItem<T>; index: number };

export function filterItems<T>(items: PickItem<T>[], query: string): PickItem<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  // Label matches rank first (prefix, then substring), then hint and group matches.
  const rank = (i: PickItem<T>): number => {
    const label = i.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    return `${i.hint ?? ''} ${i.group ?? ''}`.toLowerCase().includes(q) ? 2 : 3;
  };
  return items
    .map((item, index) => ({ item, index, r: rank(item) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map((x) => x.item);
}

/** Lay items out as header and item rows, grouped in first-seen order. */
export function buildRows<T>(items: PickItem<T>[]): Row<T>[] {
  const groups = new Map<string, PickItem<T>[]>();
  for (const it of items) {
    const g = it.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(it);
  }
  const rows: Row<T>[] = [];
  let index = 0;
  for (const [g, list] of groups) {
    if (g) rows.push({ header: g });
    for (const item of list) rows.push({ item, index: index++ });
  }
  return rows;
}

/**
 * Arrow-key picker. Resolves with the chosen value, or null when cancelled.
 * Needs a TTY on stdin and stdout; callers check `interactive()` first.
 */
export function pick<T>(title: string, items: PickItem<T>[], opts: PickOptions = {}): Promise<T | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const c = out();
  if (!stdin.isTTY || !stdout.isTTY || items.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let query = '';
    let selected = 0;
    let drawn = 0;

    const visible = () => filterItems(items, query);

    const render = () => {
      const list = visible();
      if (selected >= list.length) selected = Math.max(0, list.length - 1);
      const rows = buildRows(list);
      const maxRows = Math.max(5, ((stdout.rows || 24) - 6));
      const selRow = rows.findIndex((r) => 'item' in r && r.index === selected);
      let start = 0;
      if (rows.length > maxRows) {
        start = Math.min(Math.max(0, selRow - Math.floor(maxRows / 2)), rows.length - maxRows);
      }
      const shown = rows.slice(start, start + maxRows);
      const labelWidth = Math.max(0, ...list.map((i) => stripAnsi(i.label).length));

      const lines: string[] = [];
      lines.push(`${c.boldBrand('?')} ${c.bold(title)}`);
      if (opts.search) lines.push(`  ${c.dim('filter:')} ${query}${c.dim('▏')}`);
      if (start > 0) lines.push(c.dim('  ↑ more'));
      for (const r of shown) {
        if ('header' in r) {
          lines.push(`  ${c.dim(c.bold(r.header))}`);
        } else {
          const pad = ' '.repeat(Math.max(0, labelWidth - stripAnsi(r.item.label).length));
          const hint = r.item.hint ? `  ${c.dim(r.item.hint)}` : '';
          const body = `${r.item.label}${pad}${hint}`;
          lines.push(r.index === selected ? `${c.brand('❯')} ${c.bold(body)}` : `  ${body}`);
        }
      }
      if (list.length === 0) lines.push(c.dim('  no matches'));
      if (start + maxRows < rows.length) lines.push(c.dim('  ↓ more'));
      const keys = opts.search ? '↑/↓ move · enter select · esc cancel' : '↑/↓ move · enter select · q quit';
      lines.push(c.dim(`  ${opts.footer ?? keys}`));

      if (drawn > 0) stdout.write(`\x1b[${drawn}A\x1b[J`);
      stdout.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };

    const finish = (value: T | null, echo?: string) => {
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      if (drawn > 0) stdout.write(`\x1b[${drawn}A\x1b[J`);
      stdout.write('\x1b[?25h');
      if (echo) stdout.write(`${c.boldBrand('?')} ${c.bold(title)} ${c.cyan(echo)}\n`);
      resolve(value);
    };

    const onKey = (str: string | undefined, key: readline.Key) => {
      const list = visible();
      if (key.ctrl && key.name === 'c') return finish(null);
      if (key.name === 'escape') return finish(null);
      if (key.name === 'return' || key.name === 'enter') {
        const it = list[selected];
        return it ? finish(it.value, stripAnsi(it.label)) : undefined;
      }
      if (key.name === 'up' || (!opts.search && key.name === 'k')) {
        selected = list.length ? (selected - 1 + list.length) % list.length : 0;
      } else if (key.name === 'down' || (!opts.search && key.name === 'j')) {
        selected = list.length ? (selected + 1) % list.length : 0;
      } else if (!opts.search && key.name === 'q') {
        return finish(null);
      } else if (opts.search && key.name === 'backspace') {
        query = query.slice(0, -1);
        selected = 0;
      } else if (opts.search && str && !key.ctrl && !key.meta && str >= ' ') {
        query += str;
        selected = 0;
      } else {
        return;
      }
      render();
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l');
    stdin.on('keypress', onKey);
    render();
  });
}
