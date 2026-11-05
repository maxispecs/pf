import type { Key } from 'node:readline';
import { listenKeys } from './keys.js';
import { fitLine, out, stripAnsi, type Palette } from './palette.js';

export interface PickItem<T> {
  value: T;
  label: string;
  /** Dim text next to the label. */
  hint?: string;
  /** Longer text shown under the list while this item is highlighted (for example the resolved command). */
  detail?: string;
  group?: string;
  /** Reason this item cannot be chosen. It is shown dimmed and the cursor skips it. */
  disabled?: string;
}

export interface PickOptions<T> {
  /** Type to filter (turns off the j/k/q/digit shortcuts). Defaults to on for long lists. */
  search?: boolean;
  footer?: string;
  /** Extra lines drawn under the list (and the detail line), above the key hints. Already styled. */
  trailer?: string[];
  /** Single-select: value to start on. */
  initial?: T;
  /** Multi-select: values that start checked. */
  defaults?: T[];
  /** Show group names as headers (default). When false, groups are separated by a blank line instead. */
  groupNames?: boolean;
}

/** Lists longer than this open in type-to-filter mode. */
export const SEARCH_AFTER = 8;

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

/** Lay items out as header and item rows, grouped in first-seen order. An empty header is a blank separator. */
export function buildRows<T>(items: PickItem<T>[], names = true): Row<T>[] {
  const groups = new Map<string, PickItem<T>[]>();
  for (const it of items) {
    const g = it.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(it);
  }
  const rows: Row<T>[] = [];
  let index = 0;
  for (const [g, list] of groups) {
    if (names ? g : rows.length) rows.push({ header: names ? g : '' });
    for (const item of list) rows.push({ item, index: index++ });
  }
  return rows;
}

// ---- pure state and key handling (unit-tested without a terminal) ----

export interface PickerState {
  query: string;
  /** Index into the filtered list. */
  cursor: number;
  /** Indexes into the original item array. */
  checked: Set<number>;
}

export interface PickerConfig<T> {
  items: PickItem<T>[];
  search: boolean;
  multi: boolean;
  /** Rows to jump on PageUp/PageDown. */
  page: number;
}

export type KeyResult = 'render' | 'submit' | 'cancel' | 'ignore';

/** Nearest enabled index to `i`, looking in direction `dir` first. */
function settle<T>(list: PickItem<T>[], i: number, dir: 1 | -1 = 1): number {
  const n = list.length;
  if (n === 0) return 0;
  const j = Math.min(Math.max(i, 0), n - 1);
  for (let k = j; k >= 0 && k < n; k += dir) if (!list[k]!.disabled) return k;
  for (let k = j; k >= 0 && k < n; k -= dir) if (!list[k]!.disabled) return k;
  return j;
}

/** Next enabled index, wrapping around. */
function step<T>(list: PickItem<T>[], from: number, dir: 1 | -1): number {
  const n = list.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!list[i]!.disabled) return i;
  }
  return from;
}

export function initialState<T>(items: PickItem<T>[], opts: PickOptions<T> = {}): PickerState {
  const st: PickerState = { query: '', cursor: 0, checked: new Set() };
  if (opts.initial !== undefined) {
    const at = items.findIndex((i) => i.value === opts.initial);
    if (at !== -1) st.cursor = at;
  }
  for (const v of opts.defaults ?? []) {
    const at = items.findIndex((i) => i.value === v && !i.disabled);
    if (at !== -1) st.checked.add(at);
  }
  st.cursor = settle(items, st.cursor);
  return st;
}

function toggle<T>(st: PickerState, cfg: PickerConfig<T>, item: PickItem<T> | undefined): void {
  if (!item || item.disabled) return;
  const at = cfg.items.indexOf(item);
  if (st.checked.has(at)) st.checked.delete(at);
  else st.checked.add(at);
}

/** Apply one keypress to the state. Returns what the caller should do next. */
export function handleKey<T>(st: PickerState, str: string | undefined, key: Key, cfg: PickerConfig<T>): KeyResult {
  const list = filterItems(cfg.items, st.query);
  if (st.cursor >= list.length) st.cursor = Math.max(0, list.length - 1);
  const name = key.name;
  const plain = !key.ctrl && !key.meta;

  if (key.ctrl && name === 'c') return 'cancel';
  // A single esc leaves at once, even with a filter typed.
  if (name === 'escape') return 'cancel';
  if (name === 'return' || name === 'enter') {
    if (cfg.multi) return 'submit';
    const it = list[st.cursor];
    return it && !it.disabled ? 'submit' : 'ignore';
  }

  if (name === 'up' || (key.ctrl && name === 'p') || (!cfg.search && plain && name === 'k')) {
    st.cursor = step(list, st.cursor, -1);
    return 'render';
  }
  if (name === 'down' || (key.ctrl && name === 'n') || (!cfg.search && plain && name === 'j')) {
    st.cursor = step(list, st.cursor, 1);
    return 'render';
  }
  if (name === 'home') {
    st.cursor = settle(list, 0, 1);
    return 'render';
  }
  if (name === 'end') {
    st.cursor = settle(list, list.length - 1, -1);
    return 'render';
  }
  if (name === 'pageup') {
    st.cursor = settle(list, st.cursor - cfg.page, -1);
    return 'render';
  }
  if (name === 'pagedown') {
    st.cursor = settle(list, st.cursor + cfg.page, 1);
    return 'render';
  }

  if (cfg.multi) {
    if (name === 'space' || str === ' ') {
      toggle(st, cfg, list[st.cursor]);
      return 'render';
    }
    const selectAll = cfg.search ? key.ctrl && name === 'a' : plain && name === 'a';
    if (selectAll) {
      const enabled = list.filter((i) => !i.disabled);
      const allOn = enabled.every((i) => st.checked.has(cfg.items.indexOf(i)));
      for (const i of enabled) {
        const at = cfg.items.indexOf(i);
        if (allOn) st.checked.delete(at);
        else st.checked.add(at);
      }
      return 'render';
    }
    if (!cfg.search && plain && name === 'i') {
      for (const i of list) toggle(st, cfg, i);
      return 'render';
    }
  }

  if (!cfg.search) {
    if (plain && name === 'q') return 'cancel';
    if (str && /^[1-9]$/.test(str)) {
      const at = Number(str) - 1;
      const item = list[at];
      if (!item || item.disabled) return 'ignore';
      st.cursor = at;
      if (cfg.multi) toggle(st, cfg, item);
      return cfg.multi ? 'render' : 'submit';
    }
    return 'ignore';
  }

  if (name === 'backspace') {
    st.query = st.query.slice(0, -1);
    st.cursor = settle(filterItems(cfg.items, st.query), 0);
    return 'render';
  }
  if (str && plain && str >= ' ') {
    st.query += str;
    st.cursor = settle(filterItems(cfg.items, st.query), 0);
    return 'render';
  }
  return 'ignore';
}

/** Values chosen when the user presses enter. */
export function chosenValues<T>(st: PickerState, cfg: PickerConfig<T>): PickItem<T>[] {
  if (cfg.multi) return cfg.items.filter((it, i) => st.checked.has(i) && !it.disabled);
  const it = filterItems(cfg.items, st.query)[st.cursor];
  return it ? [it] : [];
}

// ---- rendering ----

export interface PickerView<T> extends PickerConfig<T> {
  title: string;
  footer?: string;
  trailer?: string[];
  groupNames?: boolean;
}

/** Draw the picker as lines, each already cut to the terminal width. */
export function renderPicker<T>(v: PickerView<T>, st: PickerState, cols: number, termRows: number, c: Palette): string[] {
  const list = filterItems(v.items, st.query);
  const cursor = Math.min(st.cursor, Math.max(0, list.length - 1));
  const rows = buildRows(list, v.groupNames ?? true);
  const hasDetail = v.items.some((i) => i.detail);
  const trailer = v.trailer ?? [];
  const maxRows = Math.max(5, termRows - (hasDetail ? 8 : 7) - trailer.length);
  const selRow = rows.findIndex((r) => 'item' in r && r.index === cursor);
  let start = 0;
  if (rows.length > maxRows) {
    start = Math.min(Math.max(0, selRow - Math.floor(maxRows / 2)), rows.length - maxRows);
  }
  const shown = rows.slice(start, start + maxRows);
  const labelWidth = Math.max(0, ...list.map((i) => stripAnsi(i.label).length));
  const numbered = !v.search;

  const lines: string[] = [];
  const count = v.multi ? `  ${c.dim(`(${st.checked.size} selected)`)}` : '';
  lines.push(`${c.boldBrand('?')} ${c.bold(v.title)}${count}`);
  if (v.search) lines.push(`  ${c.dim('filter:')} ${st.query}${c.dim('▏')}`);
  if (start > 0) lines.push(c.dim('  ↑ more'));
  for (const r of shown) {
    if ('header' in r) {
      lines.push(r.header ? `  ${c.dim(c.bold(r.header))}` : '');
      continue;
    }
    const { item } = r;
    const selected = r.index === cursor;
    const pointer = selected ? c.brand('❯') : ' ';
    const num = numbered ? `${r.index < 9 ? c.dim(String(r.index + 1)) : ' '} ` : '';
    const mark = v.multi ? `${st.checked.has(v.items.indexOf(item)) ? c.green('◉') : c.dim('○')} ` : '';
    const label = item.disabled ? c.dim(item.label) : selected ? c.bold(item.label) : item.label;
    const pad = ' '.repeat(Math.max(0, labelWidth - stripAnsi(item.label).length));
    const hint = item.disabled ? `  ${c.dim(`(${item.disabled})`)}` : item.hint ? `  ${c.dim(item.hint)}` : '';
    lines.push(`${pointer} ${num}${mark}${label}${pad}${hint}`);
  }
  if (list.length === 0) lines.push(c.dim('  no matches'));
  if (start + maxRows < rows.length) lines.push(c.dim('  ↓ more'));
  if (hasDetail) lines.push(list[cursor]?.detail ? `  ${c.dim('›')} ${c.dim(list[cursor]!.detail!)}` : '');

  lines.push(...trailer);

  let keys: string;
  if (v.multi) {
    keys = v.search
      ? 'type to filter · space toggle · ctrl-a all · enter confirm · esc cancel'
      : 'space toggle · a all · i invert · enter confirm · q quit';
  } else {
    keys = v.search ? 'type to filter · ↑/↓ move · enter select · esc cancel' : '↑/↓ move · 1-9 jump · enter select · q quit';
  }
  lines.push(c.dim(`  ${v.footer ?? keys}`));
  return lines.map((l) => fitLine(l, Math.max(20, cols - 1)));
}

// ---- terminal session ----

function session<T>(title: string, items: PickItem<T>[], multi: boolean, opts: PickOptions<T>): Promise<PickItem<T>[] | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const c = out();
  if (!stdin.isTTY || !stdout.isTTY || items.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const rowsNow = () => stdout.rows || 24;
    const view: PickerView<T> = {
      title,
      items,
      multi,
      search: opts.search ?? items.length > SEARCH_AFTER,
      page: Math.max(1, rowsNow() - 10),
      ...(opts.footer ? { footer: opts.footer } : {}),
      ...(opts.trailer?.length ? { trailer: opts.trailer } : {}),
      ...(opts.groupNames === false ? { groupNames: false } : {}),
    };
    const st = initialState(items, opts);
    let drawn = 0;
    let stop: () => void = () => undefined;

    const clear = () => {
      if (drawn > 0) stdout.write(`\r\x1b[${drawn}A\x1b[J`);
      drawn = 0;
    };
    const render = () => {
      view.page = Math.max(1, rowsNow() - 10);
      const lines = renderPicker(view, st, stdout.columns || 80, rowsNow(), c);
      clear();
      stdout.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };
    const finish = (picked: PickItem<T>[] | null) => {
      stdout.removeListener('resize', render);
      stop();
      clear();
      if (picked) {
        const echo = picked.length ? picked.map((p) => stripAnsi(p.label)).join(', ') : 'none';
        stdout.write(fitLine(`${c.boldBrand('?')} ${c.bold(title)} ${c.cyan(echo)}`, (stdout.columns || 80) - 1) + '\n');
      }
      resolve(picked);
    };

    stop = listenKeys((str, key) => {
      const result = handleKey(st, str, key, view);
      if (result === 'render') render();
      else if (result === 'cancel') finish(null);
      else if (result === 'submit') finish(chosenValues(st, view));
    }, stdout);
    stdout.on('resize', render);
    render();
  });
}

/**
 * Arrow-key picker. Resolves with the chosen value, or null when cancelled.
 * Needs a TTY on stdin and stdout; callers check `interactive()` first.
 */
export async function pick<T>(title: string, items: PickItem<T>[], opts: PickOptions<T> = {}): Promise<T | null> {
  const r = await session(title, items, false, opts);
  return r && r[0] ? r[0].value : null;
}

/**
 * Checkbox list. Space toggles, enter confirms. Resolves with the checked values (possibly
 * none), or null when cancelled or there is no terminal.
 */
export async function multiPick<T>(title: string, items: PickItem<T>[], opts: PickOptions<T> = {}): Promise<T[] | null> {
  const r = await session(title, items, true, opts);
  return r ? r.map((i) => i.value) : null;
}
