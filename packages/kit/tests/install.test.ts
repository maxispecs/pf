import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContext } from '../src/context.js';
import { detectInstall, findInstallTargets, installTargetOf } from '../src/detect/install.js';
import { json, lines, mkRepo } from './helpers.js';

const ctxOf = (files: Record<string, string>) => buildContext(mkRepo({ '.git/HEAD': '', ...files }));

test('installTargetOf names the target of an install script', () => {
  assert.equal(installTargetOf('install:local'), 'local');
  assert.equal(installTargetOf('install-local'), 'local');
  assert.equal(installTargetOf('local:install'), 'local');
  assert.equal(installTargetOf('install:cursor'), 'cursor');
  assert.equal(installTargetOf('install'), null);
  assert.equal(installTargetOf('postinstall'), null);
  assert.equal(installTargetOf('deploy:staging'), null);
});

test('install targets come from package.json scripts, local first', () => {
  const ctx = ctxOf({
    'package.json': json({ scripts: { 'install:cursor': 'a', 'install:local': 'b', install: 'c', build: 'd' } }),
    'pnpm-lock.yaml': '',
  });
  assert.deepEqual([...findInstallTargets(ctx).keys()], ['local', 'cursor']);
  assert.deepEqual(lines([detectInstall(ctx, 'local')!]), ['pnpm run install:local']);
  assert.deepEqual(lines([detectInstall(ctx, 'cursor')!]), ['pnpm run install:cursor']);
  assert.equal(detectInstall(ctx, 'nope'), null);
});

test('a plain install script is not a target', () => {
  assert.equal(findInstallTargets(ctxOf({ 'package.json': json({ scripts: { install: 'x' } }) })).size, 0);
});

test('pulpfixer.json wins over package.json, and install:colon beats install-dash', () => {
  const ctx = ctxOf({
    'package.json': json({ scripts: { 'install-local': 'a', 'install:local': 'b' } }),
    'pulpfixer.json': json({ commands: { 'install:cursor': { run: 'echo cursor' } } }),
  });
  assert.deepEqual(lines([detectInstall(ctx, 'cursor')!]), ['echo cursor']);
  assert.deepEqual(lines([detectInstall(ctx, 'local')!]), ['npm run install:local']);
  const over = ctxOf({
    'package.json': json({ scripts: { 'install:local': 'a' } }),
    'pulpfixer.json': json({ commands: { 'install:local': { run: 'echo mine' } } }),
  });
  assert.deepEqual(lines([detectInstall(over, 'local')!]), ['echo mine']);
});

test('install targets are found in workspace packages, root first', () => {
  const ctx = ctxOf({
    'package.json': json({ scripts: {} }),
    'packages/ext/package.json': json({ scripts: { 'install:local': 'x' } }),
  });
  const cand = detectInstall(ctx, 'local')!;
  assert.match(cand.source, /packages\/ext\/package\.json script install:local/);
  const both = ctxOf({
    'package.json': json({ scripts: { 'install:local': 'root' } }),
    'packages/ext/package.json': json({ scripts: { 'install:local': 'x' } }),
  });
  assert.match(detectInstall(both, 'local')!.source, /^\.\/package\.json/);
});

test('install targets are found in composer scripts and the local ./a CLI', () => {
  const composer = ctxOf({ 'composer.json': json({ scripts: { 'install:local': 'x' } }) });
  assert.deepEqual(lines([detectInstall(composer, 'local')!]), ['composer run install:local']);
  const cli = ctxOf({ a: '', 'cli/run': '', 'cli/commands/install/local.sh': '# desc: install\n# usage: ./a install:local -y\n' });
  const cand = detectInstall(cli, 'local')!;
  assert.deepEqual(lines([cand]), ['./a install:local']); // never -y: pf did not ask
});
