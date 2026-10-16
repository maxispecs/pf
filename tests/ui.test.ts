import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBanner } from '../src/ui/banner.js';
import { palette, stripAnsi } from '../src/ui/palette.js';
import { buildRows, filterItems } from '../src/ui/picker.js';
import { compareVersions } from '../src/util.js';
import { displayVersion } from '../src/version.js';
import { bashCompletion, fishCompletion, rcBlock, stripRcBlock, zshCompletion } from '../src/install/completions.js';

const plain = { ...palette(process.stderr), on: false };
const off = (() => {
  const id = (s: string) => s;
  return { on: false, bold: id, dim: id, red: id, green: id, yellow: id, blue: id, magenta: id, cyan: id, brand: id, boldBrand: id, inverse: id };
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
