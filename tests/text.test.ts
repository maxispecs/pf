import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette, stripAnsi, type Palette } from '../src/ui/palette.js';
import { badge, badgeLabel, br, h1, h2, ol, promptLine, table, term, termLine, ul, usageTable } from '../src/ui/text.js';

const off: Palette = { ...palette(process.stderr), on: false, ...Object.fromEntries(['bold', 'dim', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brand', 'boldBrand', 'inverse'].map((k) => [k, (s: string) => s])) } as Palette;

/** A palette with colors forced on, whatever the test runner's terminal is. */
function colored(): Palette {
  const saved = { n: process.env.NO_COLOR, f: process.env.FORCE_COLOR };
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  try {
    return palette(process.stderr);
  } finally {
    if (saved.n === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.n;
    if (saved.f === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved.f;
  }
}

test('termLine leaves the text unchanged without color', () => {
  for (const line of ['pf dev --dry-run', 'pf ver [list|bump <target> <major|minor>|init|sync] [--dry-run]', "pnpm run dev 'two words'  (in apps/docs)", 'cd x && pnpm dev']) {
    assert.equal(termLine(line, off), line);
  }
});

test('termLine paints each part of a command in its own color', () => {
  const c = colored();
  const t = term(c);
  assert.equal(
    termLine('pf deploy staging [--dry-run] <name>', c),
    [t.command('pf'), ' ', t.sub('deploy'), ' staging ', t.punct('['), t.flag('--dry-run'), t.punct(']'), ' ', t.args('<name>')].join(''),
  );
  assert.equal(stripAnsi(termLine('pf deploy staging [--dry-run] <name>', c)), 'pf deploy staging [--dry-run] <name>');
});

test('termLine: words inside brackets are placeholders, shell operators restart the command', () => {
  const c = colored();
  const t = term(c);
  assert.equal(termLine('pf skill [name]', c), `${t.command('pf')} ${t.sub('skill')} ${t.punct('[')}${t.args('name')}${t.punct(']')}`);
  assert.equal(termLine('cd x && pnpm dev', c), `${t.command('cd')} ${t.sub('x')} ${t.punct('&&')} ${t.command('pnpm')} ${t.sub('dev')}`);
  assert.equal(termLine('pnpm run dev  (in apps/docs)', c), `${t.command('pnpm')} ${t.sub('run')} dev  ${t.punct('(in apps/docs)')}`);
});

test('termLine keeps quoted arguments whole', () => {
  const c = colored();
  assert.equal(stripAnsi(termLine("pf skill 'a b' --list", c)), "pf skill 'a b' --list");
  assert.ok(termLine("pf skill 'a b'", c).includes("'a b'"));
});

test('promptLine puts a dim $ in front', () => {
  assert.equal(promptLine('pf dev', off), '$ pf dev');
  const c = colored();
  assert.equal(promptLine('pf dev', c), term(c).prefix() + termLine('pf dev', c));
});

test('term.format builds a sample from its parts', () => {
  assert.equal(term(off).format('pf', 'deploy', '<args>'), '$ pf deploy <args>');
  assert.equal(term(off).format('pf'), '$ pf');
});

test('badges fall back to a plain label without color', () => {
  assert.equal(badgeLabel('error', off), 'error:');
  assert.equal(badge.error('no repo', off), 'error: no repo');
  assert.equal(badge.warning('careful', off), 'warning: careful');
  assert.equal(badge.success('done', off), 'success: done');
  assert.equal(badge.info('fyi', off), 'info: fyi');
});

test('badges are a padded label on a background with color', () => {
  const c = colored();
  assert.equal(badgeLabel('error', c), '\x1b[1;97;101m error \x1b[0m');
  assert.equal(stripAnsi(badge.success('done', c)), ' success  done');
  assert.notEqual(badgeLabel('warning', c), badgeLabel('info', c));
});

test('headings and lists', () => {
  assert.equal(h1('Title', off), 'Title');
  assert.equal(h2('Section', off), 'Section');
  assert.equal(br(), '\n');
  assert.equal(br(3), '\n\n\n');
  assert.equal(ul(['a', 'b'], off), '- a\n- b');
  assert.equal(ul(['a'], off, '*'), '* a');
  assert.equal(ol(['a', 'b'], off), '1. a\n2. b');
});

test('table pads columns on the visible width, colored or not', () => {
  const rows = [
    ['pf dev', 'Run it'],
    ['pf deploy staging', 'Ship it'],
  ];
  const plain = table(['Usage', 'Description'], rows, off).split('\n');
  assert.equal(plain.length, 6);
  assert.equal(new Set(plain.map((l) => l.length)).size, 1);
  assert.equal(plain[0], '┌' + '─'.repeat(19) + '┬' + '─'.repeat(13) + '┐');
  assert.equal(plain[1], '│ Usage             │ Description │');
  assert.equal(plain[3], '│ pf dev            │ Run it      │');

  const c = colored();
  const painted = table(['Usage', 'Description'], rows.map(([u, d]) => [termLine(u!, c), d!]), c).split('\n');
  assert.deepEqual(painted.map(stripAnsi), table(['Usage', 'Description'], rows, off).split('\n'));
});

test('table cuts lines to the requested width', () => {
  const lines = table(['A'], [['x'.repeat(80)]], off, { cols: 40 }).split('\n');
  for (const l of lines) assert.ok(stripAnsi(l).length <= 40, l);
});

test('usageTable has the old Usage and Description columns', () => {
  const out = usageTable([{ usage: 'pf dev [--dry-run]', summary: 'Run the dev server' }], off).split('\n');
  assert.match(out[1]!, /Usage\s+│ Description/);
  assert.match(out[3]!, /\$ pf dev \[--dry-run\]\s+│ Run the dev server/);
});
