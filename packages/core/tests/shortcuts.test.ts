import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allCommands } from '../src/commands/index.js';
import { SHORTCUTS, shortcutCommand, shortcutCommands } from '../src/commands/shortcuts.js';
import { shortcutLines } from '../src/commands/shortcutlist.js';
import { entriesFor } from '../src/menu.js';
import { buildContext } from '@pulpfixer/kit/context';
import { detectProduction } from '@pulpfixer/kit/detect/deploy';
import { json, lines, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

function pf(cwd: string, ...args: string[]) {
  const env = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_HOME: mkRepo({}) };
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, err: r.stderr };
}

test('shortcut names are unique and do not shadow other commands', () => {
  const names = allCommands().map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const s of SHORTCUTS) for (const n of s.names) assert.ok(names.includes(n));
});

test('a shortcut runs its target with the fixed args first', async () => {
  let got: string[] = [];
  const cmd = shortcutCommand(
    { names: ['x'], target: ['deploy', 'staging'], summary: '', group: 'Tools' },
    'x',
    () => ({ name: 'deploy', summary: '', group: 'Tools', usage: '', run: async (_c, a) => ((got = a), 7) }),
  );
  assert.equal(await cmd.run({} as never, ['--dry-run']), 7);
  assert.deepEqual(got, ['staging', '--dry-run']);
});

test('a shortcut can have several names, all running the same target', () => {
  const cmds = shortcutCommands({ names: ['up', 'put'], target: ['s3'], summary: '', group: 'AWS' }, () => undefined);
  assert.deepEqual(cmds.map((c) => c.name), ['up', 'put']);
  assert.ok(allCommands().some((c) => c.name === 'up'));
});

test('production is only taken from pulpfixer.json or a production script', () => {
  const script = detectProduction(buildContext(mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'deploy:production': 'x' } }) })));
  assert.deepEqual(lines(script.steps), ['npm run deploy:production']);
  const none = detectProduction(buildContext(mkRepo({ '.git/HEAD': '', 'vercel.json': '{}', 'netlify.toml': '' })));
  assert.deepEqual(none.steps, []);
});

test('pf ds and pf dp preview with --dry-run', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'deploy:staging': 'a', 'deploy:production': 'b' } }), 'pnpm-lock.yaml': '' });
  const ds = pf(dir, 'ds', '--dry-run');
  assert.equal(ds.code, 0);
  assert.match(ds.err, /pnpm run deploy:staging/);
  const dp = pf(dir, 'dp', '--dry-run');
  assert.equal(dp.code, 0);
  assert.match(dp.err, /PRODUCTION/);
  assert.match(dp.err, /pnpm run deploy:production/);
});

test('pf r runs the repo dev command', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { dev: 'x' } }), 'pnpm-lock.yaml': '' });
  const r = pf(dir, 'r', '--dry-run');
  assert.equal(r.code, 0);
  assert.match(r.err, /pnpm run dev/);
});

test('pf docs is pf doc: it previews the docs site start with --dry-run', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'docs:dev': 'x' } }), 'pnpm-lock.yaml': '' });
  const docs = pf(dir, 'docs', '--dry-run');
  assert.equal(docs.code, 0);
  assert.match(docs.err, /pnpm run docs:dev/);
  assert.equal(pf(dir, 'doc', '--dry-run').code, 0);
  const none = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: {} }) });
  assert.equal(pf(none, 'docs', '--dry-run').code, 1);
});

test('pf ps previews the repo publish:cellars script with --dry-run', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'publish:cellars': 'x' } }), 'pnpm-lock.yaml': '' });
  const ps = pf(dir, 'ps', '--dry-run');
  assert.equal(ps.code, 0);
  assert.match(ps.err, /pnpm run publish:cellars/);
  assert.equal(pf(dir, 'ps').code, 2); // no terminal: needs --yes
  assert.equal(pf(mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: {} }) }), 'ps', '--dry-run').code, 1);
  const override = mkRepo({ '.git/HEAD': '', 'pulpfixer.json': json({ commands: { 'publish:staging': { run: 'echo hi' } } }) });
  assert.match(pf(override, 'ps', '--dry-run').err, /echo hi/);
});

test('pf dp without --yes refuses without a terminal', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'deploy:production': 'b' } }) });
  assert.equal(pf(dir, 'dp').code, 2);
});

test('shortcutLines groups the shortcuts by niche, in group order', () => {
  const c = { on: false, bold: (s: string) => s, dim: (s: string) => s } as never;
  const lines = shortcutLines(
    [
      { names: ['up', 'put'], target: ['s3'], summary: 'Upload', group: 'AWS' },
      { names: ['a'], target: ['agent'], summary: 'Agent', group: 'Agent' },
      { names: ['ds'], target: ['deploy', 'staging'], summary: 'Staging', group: 'Docs & deploy' },
    ],
    c,
  );
  const heads = lines.filter((l) => !l.startsWith(' ') && l);
  assert.deepEqual(heads, ['Agent', 'Docs & deploy', 'AWS']);
  assert.match(lines.join('\n'), /pf up, pf put\s+= pf s3\s+Upload/);
  assert.deepEqual(shortcutLines(SHORTCUTS, c, 'staging').filter((l) => l.startsWith('  ')).length > 0, true);
  assert.deepEqual(shortcutLines(SHORTCUTS, c, 'no-such-thing'), []);
});

test('pf s and pf shortcuts list the shortcuts; pf list and the menu do not', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { dev: 'x', 'deploy:staging': 'y' } }), 'pnpm-lock.yaml': '' });
  const run = (...args: string[]) => {
    const env = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_HOME: mkRepo({}) };
    return spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd: dir, encoding: 'utf8', env });
  };
  for (const name of ['s', 'shortcuts']) {
    const r = run(name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Docs & deploy/);
    assert.match(r.stdout, /pf ds\s+= pf deploy staging/);
  }
  assert.equal(run('s', 'no-such-thing').status, 1);
  for (const args of [['list'], []]) {
    const r = run(...args);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /Shortcuts|= deploy staging/);
    assert.match(r.stdout, /pf s\b/);
  }
});

test('in a repo, the entries adapted from it come before pf\'s own', () => {
  const dir = mkRepo({
    '.git/HEAD': '',
    'package.json': json({ scripts: { dev: 'x', build: 'y', 'deploy:staging': 'z' } }),
    'pnpm-lock.yaml': '',
    'pulpfixer.json': json({ commands: { seed: { run: 'echo seed' } } }),
  });
  const names = entriesFor(buildContext(dir)).map((e) => e.name);
  const last = Math.max(...['dev', 'build', 'deploy staging', 'seed'].map((n) => names.indexOf(n)));
  assert.ok(['dev', 'build', 'deploy staging', 'seed'].every((n) => names.includes(n)));
  assert.ok(last < names.indexOf('agent'), `repo entries first: ${names.join(', ')}`);
  assert.ok(last < names.indexOf('ver'));
  assert.ok(entriesFor(buildContext(mkRepo({}))).map((e) => e.name).includes('agent'));
});
