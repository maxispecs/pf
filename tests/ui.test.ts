import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wantsLogo } from '../src/cli.js';
import { LOGO_MIN_COLS, LOGO_MIN_ROWS, logoFits, renderBanner, renderLogo } from '../src/ui/banner.js';
import { fitLine, palette, stripAnsi, type Palette } from '../src/ui/palette.js';
import { LOGO_ART, LOGO_COLORS } from '../src/ui/logo-art.js';
import { confirmKey, renderConfirm } from '../src/ui/prompt.js';
import {
  buildRows,
  chosenValues,
  filterItems,
  handleKey,
  initialState,
  renderPicker,
  type PickItem,
  type PickerConfig,
} from '../src/ui/picker.js';
import { compareVersions } from '../src/util.js';
import { displayVersion } from '../src/version.js';
import { bashCompletion, fishCompletion, rcBlock, stripRcBlock, zshCompletion } from '../src/install/completions.js';

const plain = { ...palette(process.stderr), on: false };
const off: Palette = (() => {
  const id = (s: string) => s;
  return { on: false, bold: id, dim: id, red: id, green: id, yellow: id, blue: id, magenta: id, cyan: id, brand: id, boldBrand: id, inverse: id, fg: (_n, s) => s };
})();
void plain;

test('banner always carries the version', () => {
  assert.equal(renderBanner({ version: '2.0.0' }, off), 'pf v2.0');
  assert.equal(renderBanner({ version: '2.1.0', repo: 'web', stacks: ['Node (pnpm)'] }, off), 'pf v2.1  ·  web  Node (pnpm)');
});

test('banner hints at a newer version only when there is one', () => {
  assert.match(renderBanner({ version: '2.0.0', latest: '2.1.0' }, off), /v2\.1 available, run pf update/);
  assert.doesNotMatch(renderBanner({ version: '2.1.0', latest: '2.1.0' }, off), /available/);
  assert.doesNotMatch(renderBanner({ version: '2.1.0', latest: '2.0.0' }, off), /available/);
});

test('displayVersion drops a zero patch', () => {
  assert.equal(displayVersion('2.0.0'), '2.0');
  assert.equal(displayVersion('2.3.1'), '2.3.1');
});

test('compareVersions', () => {
  assert.equal(compareVersions('2.0.0', '1.8.6'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('2.1.0', '2.10.0'), -1);
});

test('colors turn off with NO_COLOR and stripAnsi removes escapes', () => {
  const saved = { n: process.env.NO_COLOR, f: process.env.FORCE_COLOR };
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  const on = palette(process.stdout).green('x');
  assert.equal(on, '\x1b[32mx\x1b[0m');
  assert.equal(stripAnsi(on), 'x');
  process.env.NO_COLOR = '1';
  assert.equal(palette(process.stdout).green('x'), 'x');
  if (saved.n === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.n;
  if (saved.f === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved.f;
});

test('picker rows group items and keep selection indexes', () => {
  const items = [
    { value: 1, label: 'a', group: 'G1' },
    { value: 2, label: 'b', group: 'G2' },
    { value: 3, label: 'c', group: 'G1' },
  ];
  const rows = buildRows(items);
  assert.deepEqual(rows.map((r) => ('header' in r ? r.header : `${r.item.label}:${r.index}`)), ['G1', 'a:0', 'c:1', 'G2', 'b:2']);
});

test('picker filter matches label, hint and group', () => {
  const items = [
    { value: 1, label: 'dev', hint: 'run the app' },
    { value: 2, label: 'skill', hint: 'agents' },
  ];
  assert.deepEqual(filterItems(items, 'APP').map((i) => i.value), [1]);
  assert.deepEqual(filterItems(items, '').length, 2);
  assert.deepEqual(filterItems(items, 'zzz'), []);
  const ranked = [
    { value: 'a', label: 'docx', hint: 'versions of word' },
    { value: 'b', label: 'ver', hint: 'x' },
    { value: 'c', label: 'save-ver', hint: 'y' },
  ];
  assert.deepEqual(filterItems(ranked, 'ver').map((i) => i.value), ['b', 'c', 'a']);
});

test('completions list every command; the rc block can be removed again', () => {
  const cmds = [{ name: 'dev', summary: 'Run the app' }, { name: 'ver', summary: "It's versions" }];
  assert.match(zshCompletion(cmds), /'dev:Run the app'/);
  assert.match(bashCompletion(cmds), /compgen -W "dev ver"/);
  assert.match(fishCompletion(cmds), /-a 'ver'/);
  const rc = `export A=1\n\n${rcBlock('zsh', '/h/.pf')}export B=2\n`;
  const stripped = stripRcBlock(rc);
  assert.doesNotMatch(stripped, /pf >>>/);
  assert.match(stripped, /export A=1/);
  assert.match(stripped, /export B=2/);
});

// ---- logo ----

test('logo carries the version, fits its width, and is plain without color', () => {
  const logo = renderLogo({ version: '2.1.0', repo: 'web', stacks: ['Node (pnpm)'] }, off, 100);
  assert.match(logo, /pf v2\.1/);
  assert.match(logo, /web/);
  assert.ok(logo.includes(LOGO_ART[8]!), 'the dotted figure is drawn');
  assert.doesNotMatch(logo, /\x1b/);
  for (const line of logo.split('\n')) assert.ok(stripAnsi(line).length <= 99, `too wide: ${line}`);
});

test('logo gives the update hint its own row and is colored when color is on', () => {
  assert.match(renderLogo({ version: '2.0.0', latest: '2.1.0' }, off, 100), /v2\.1 available, run pf update/);
  assert.doesNotMatch(renderLogo({ version: '2.1.0', latest: '2.1.0' }, off, 100), /available/);
  const saved = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  const colored = renderLogo({ version: '2.0.0' }, palette(process.stderr), 100);
  for (const n of LOGO_COLORS) assert.match(colored, new RegExp(`38;5;${n}m`), `uses color ${n}`);
  const art = colored.split('\n').map((l) => stripAnsi(l).slice(2, 2 + LOGO_ART[0]!.length));
  assert.ok(LOGO_ART.every((row) => art.includes(row)), 'the colored art is drawn');
  assert.doesNotMatch(colored, /\x1b\[[0-9;]*48;/, 'no background color: the terminal shows through');
  if (saved === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved;
});

test('the logo is for narrow-safe terminals and the menu, about and help only', () => {
  assert.equal(logoFits(LOGO_MIN_COLS), true);
  assert.equal(logoFits(LOGO_MIN_COLS - 1), false);
  assert.equal(logoFits(undefined), false);
  assert.equal(logoFits(200, LOGO_MIN_ROWS), true);
  assert.equal(logoFits(200, LOGO_MIN_ROWS - 1), false, 'a short window gets the one-line banner');
  for (const c of [undefined, 'menu', 'about', 'help', '--help']) assert.equal(wantsLogo(c), true, String(c));
  for (const c of ['dev', 'build', 'list', '--version', 'ver']) assert.equal(wantsLogo(c), false, c);
});

test('fitLine cuts to width, keeps escapes balanced and leaves short lines alone', () => {
  assert.equal(fitLine('short', 20), 'short');
  const cut = fitLine('\x1b[1mabcdefghij\x1b[0m', 6);
  assert.equal(stripAnsi(cut), 'abcde…');
  assert.match(cut, /\x1b\[0m…$/);
  assert.equal(fitLine('abcdefghij', 6), 'abcde…');
});

// ---- picker state and rendering ----

const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });
const items = (n: number, mod: (i: number) => Partial<PickItem<number>> = () => ({})): PickItem<number>[] =>
  Array.from({ length: n }, (_, i) => ({ value: i, label: `item${i}`, ...mod(i) }));
const cfg = (list: PickItem<number>[], over: Partial<PickerConfig<number>> = {}): PickerConfig<number> => ({
  items: list,
  search: false,
  multi: false,
  page: 3,
  ...over,
});

test('single pick: arrows wrap, disabled items are skipped, enter submits the cursor item', () => {
  const list = items(4, (i) => (i === 1 ? { disabled: 'nope' } : {}));
  const c = cfg(list);
  const st = initialState(list);
  assert.equal(st.cursor, 0);
  assert.equal(handleKey(st, undefined, key('down'), c), 'render');
  assert.equal(st.cursor, 2);
  handleKey(st, undefined, key('down'), c);
  handleKey(st, undefined, key('down'), c);
  assert.equal(st.cursor, 0, 'wraps around, skipping the disabled item');
  handleKey(st, undefined, key('up'), c);
  assert.equal(st.cursor, 3);
  assert.equal(handleKey(st, undefined, key('return'), c), 'submit');
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [3]);
  assert.equal(handleKey(st, undefined, key('escape'), c), 'cancel');
  assert.equal(handleKey(st, 'q', key('q'), c), 'cancel');
});

test('single pick: home, end, page keys and digit quick-select', () => {
  const list = items(10);
  const c = cfg(list);
  const st = initialState(list);
  handleKey(st, undefined, key('end'), c);
  assert.equal(st.cursor, 9);
  handleKey(st, undefined, key('pageup'), c);
  assert.equal(st.cursor, 6);
  handleKey(st, undefined, key('home'), c);
  assert.equal(st.cursor, 0);
  assert.equal(handleKey(st, '3', key('3'), c), 'submit');
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [2]);
  const dis = items(3, (i) => (i === 0 ? { disabled: 'x' } : {}));
  assert.equal(handleKey(initialState(dis), '1', key('1'), cfg(dis)), 'ignore');
});

test('single pick: initial value sets the cursor; a disabled initial moves to an enabled item', () => {
  assert.equal(initialState(items(5), { initial: 3 }).cursor, 3);
  const list = items(3, (i) => (i === 0 ? { disabled: 'x' } : {}));
  assert.equal(initialState(list, { initial: 0 }).cursor, 1);
});

test('search mode: typing filters, j/k/q/digits type, escape clears then cancels', () => {
  const list = [
    { value: 0, label: 'alpha' },
    { value: 1, label: 'beta' },
    { value: 2, label: 'bravo' },
  ];
  const c = cfg(list, { search: true });
  const st = initialState(list);
  handleKey(st, 'b', key('b'), c);
  assert.equal(st.query, 'b');
  assert.equal(filterItems(list, st.query).length, 2);
  handleKey(st, 'r', key('r'), c);
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [2]);
  handleKey(st, undefined, key('backspace'), c);
  assert.equal(st.query, 'b');
  handleKey(st, 'q', key('q'), c);
  handleKey(st, '1', key('1'), c);
  assert.equal(st.query, 'bq1');
  assert.equal(filterItems(list, st.query).length, 0);
  assert.equal(handleKey(st, undefined, key('return'), c), 'ignore', 'nothing to select');
  assert.equal(handleKey(st, undefined, key('escape'), c), 'render');
  assert.equal(st.query, '');
  assert.equal(handleKey(st, undefined, key('escape'), c), 'cancel');
});

test('multi pick: space toggles, a toggles all, i inverts, digits toggle, enter returns checked items in order', () => {
  const list = items(4, (i) => (i === 3 ? { disabled: 'x' } : {}));
  const c = cfg(list, { multi: true });
  const st = initialState(list, { defaults: [1] });
  assert.deepEqual([...st.checked], [1]);
  handleKey(st, ' ', key('space'), c);
  assert.deepEqual([...st.checked].sort(), [0, 1], 'space checks the cursor item (item0)');
  handleKey(st, ' ', key('space'), c);
  assert.deepEqual([...st.checked], [1], 'and unchecks it again');
  handleKey(st, undefined, key('down'), c);
  handleKey(st, ' ', key('space'), c);
  assert.equal(st.checked.size, 0, 'unchecks the default item1');
  handleKey(st, ' ', key('space'), c);
  handleKey(st, undefined, key('up'), c);
  handleKey(st, ' ', key('space'), c);
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [0, 1]);
  handleKey(st, 'a', key('a'), c);
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [0, 1, 2], 'select all skips disabled');
  handleKey(st, 'a', key('a'), c);
  assert.equal(st.checked.size, 0, 'a again clears');
  handleKey(st, 'i', key('i'), c);
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [0, 1, 2]);
  assert.equal(handleKey(st, '2', key('2'), c), 'render');
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [0, 2]);
  assert.equal(handleKey(st, undefined, key('return'), c), 'submit');
  assert.equal(handleKey(st, undefined, key('escape'), c), 'cancel');
});

test('multi pick in search mode keeps checks across filters and uses ctrl-a for all', () => {
  const list = [
    { value: 0, label: 'alpha' },
    { value: 1, label: 'beta' },
  ];
  const c = cfg(list, { multi: true, search: true });
  const st = initialState(list);
  handleKey(st, ' ', key('space'), c);
  handleKey(st, 'b', key('b'), c);
  handleKey(st, ' ', key('space'), c);
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [0, 1]);
  handleKey(st, undefined, key('a', { ctrl: true }), c);
  assert.deepEqual(chosenValues(st, c).map((i) => i.value), [0], 'ctrl-a toggles only the visible items');
});

test('renderPicker: lines never exceed the width and scrolling keeps the cursor in view', () => {
  const list = items(40, (i) => ({ hint: 'h'.repeat(80), group: i < 20 ? 'First' : 'Second' }));
  const c = cfg(list, { search: true });
  const st = initialState(list);
  st.cursor = 35;
  const lines = renderPicker({ ...c, title: 'Pick one' }, st, 50, 20, off);
  for (const l of lines) assert.ok(stripAnsi(l).length <= 50, `too wide: ${l}`);
  assert.ok(lines.length <= 20, `${lines.length} lines for a 20-row terminal`);
  assert.ok(lines.some((l) => l.includes('❯ item35')), 'cursor row is visible');
  assert.ok(lines.some((l) => l.includes('↑ more')));
});

test('renderPicker: shows numbers, checkboxes, disabled reasons and the detail line', () => {
  const list = [
    { value: 0, label: 'dev', hint: 'Run the app', detail: 'pnpm run dev' },
    { value: 1, label: 'doc', disabled: 'no docs site' },
  ];
  const single = renderPicker({ ...cfg(list), title: 'Go' }, initialState(list), 80, 24, off);
  assert.ok(single.some((l) => l.includes('❯ 1 dev')));
  assert.ok(single.some((l) => l.includes('2 doc') && l.includes('(no docs site)')));
  assert.ok(single.some((l) => l.includes('› pnpm run dev')));
  const multi = renderPicker({ ...cfg(list, { multi: true }), title: 'Go' }, initialState(list, { defaults: [0] }), 80, 24, off);
  assert.ok(multi[0]!.includes('(1 selected)'));
  assert.ok(multi.some((l) => l.includes('◉ dev')));
  assert.ok(multi.some((l) => l.includes('○ doc')));
});

// ---- confirm ----

test('confirm keys: y/n answer at once, enter keeps the default, arrows toggle, escape says no', () => {
  assert.deepEqual(confirmKey(false, 'y', key('y')), { value: true, done: true });
  assert.deepEqual(confirmKey(true, 'n', key('n')), { value: false, done: true });
  assert.deepEqual(confirmKey(true, undefined, key('return')), { value: true, done: true });
  assert.deepEqual(confirmKey(false, undefined, key('return')), { value: false, done: true });
  assert.deepEqual(confirmKey(false, undefined, key('right')), { value: true, done: false });
  assert.deepEqual(confirmKey(true, undefined, key('left')), { value: false, done: false });
  assert.deepEqual(confirmKey(true, undefined, key('escape')), { value: false, done: true });
  assert.deepEqual(confirmKey(true, 'c', key('c', { ctrl: true })), { value: false, done: true });
  assert.deepEqual(confirmKey(true, 'x', key('x')), { value: true, done: false });
});

test('confirm line shows the current answer', () => {
  assert.equal(renderConfirm('Go?', true, off), '? Go?  ● Yes  ○ No  (y/n)');
  assert.equal(renderConfirm('Go?', false, off), '? Go?  ○ Yes  ● No  (y/n)');
});
