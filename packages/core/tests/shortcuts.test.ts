import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allCommands } from '../src/commands/index.js';
import { SHORTCUTS, shortcutCommand, shortcutCommands } from '../src/commands/shortcuts.js';
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

test('production is only taken from pf.json or a production script', () => {
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

test('pf dp without --yes refuses without a terminal', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'deploy:production': 'b' } }) });
  assert.equal(pf(dir, 'dp').code, 2);
});
