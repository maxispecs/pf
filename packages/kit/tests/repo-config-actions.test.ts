import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ICON_NAME, loadRepoConfig, parseActionOverrides } from '../src/config.js';
import { json, mkRepo } from './helpers.js';

test('a custom command reads its icon and featured flag, and drops a bad icon name', () => {
  const root = mkRepo({
    'pulpfixer.json': json({
      commands: {
        seed: { run: './seed.sh', icon: 'database', featured: true },
        bad: { run: 'x', icon: 'Not An Icon', featured: 'yes' },
        plain: 'echo hi',
      },
    }),
  });
  const { commands } = loadRepoConfig(root);
  assert.equal(commands.seed?.icon, 'database');
  assert.equal(commands.seed?.featured, true);
  assert.equal(commands.bad?.icon, undefined);
  assert.equal(commands.bad?.featured, undefined);
  assert.equal(commands.plain?.icon, undefined);
});

test('the actions section keeps well-formed overrides only', () => {
  const root = mkRepo({
    'pulpfixer.json': json({
      actions: {
        install: { featured: false },
        'deploy:staging': { icon: 'cloud-upload', featured: true },
        junk: 'text',
        empty: {},
        wrong: { featured: 'no', icon: 'BAD' },
      },
    }),
  });
  assert.deepEqual(loadRepoConfig(root).actions, {
    install: { featured: false },
    'deploy:staging': { icon: 'cloud-upload', featured: true },
  });
});

test('no actions section means no actions key', () => {
  assert.equal(loadRepoConfig(mkRepo({ 'pulpfixer.json': json({}) })).actions, undefined);
  assert.equal(parseActionOverrides([]), undefined);
  assert.equal(parseActionOverrides({ a: {} }), undefined);
});

test('ICON_NAME accepts codicon names only', () => {
  for (const ok of ['rocket', 'cloud-upload', 'debug-start', 'x2']) assert.ok(ICON_NAME.test(ok), ok);
  for (const bad of ['', 'Rocket', 'a b', '-a', 'a-', 'a--b', '$(rocket)', 'a/b']) assert.ok(!ICON_NAME.test(bad), bad);
});
