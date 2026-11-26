import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ICON_NAME, loadRepoConfig, parseActionOverrides, parseWhen } from '../src/config.js';
import { buildStack, parseBuildStack } from '../src/version.js';
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

test('when is a name or a list, unknown names are dropped, and [] is kept (always show)', () => {
  assert.deepEqual(parseWhen('unpushed'), ['unpushed']);
  assert.deepEqual(parseWhen([' changes ', 'pfBehind', 'changes', 'nope', 3]), ['changes', 'pfBehind']);
  assert.deepEqual(parseWhen([]), []);
  assert.deepEqual(parseWhen('nope'), []);
  assert.equal(parseWhen(true), undefined);
  assert.equal(parseWhen(undefined), undefined);
});

test('an action override and a custom command read when', () => {
  const root = mkRepo({
    'pulpfixer.json': json({
      commands: { seed: { run: './seed.sh', when: 'changes' }, plain: { run: 'x', when: 5 } },
      actions: { 'git:push': { when: [] }, cycle: { when: ['pfBehind', 'bad'] }, dev: { when: 'bad' } },
    }),
  });
  const cfg = loadRepoConfig(root);
  assert.deepEqual(cfg.commands.seed?.when, ['changes']);
  assert.equal(cfg.commands.plain?.when, undefined);
  assert.deepEqual(cfg.actions, { 'git:push': { when: [] }, cycle: { when: ['pfBehind'] }, dev: { when: [] } });
});

test('buildStack reads dist/build-info.json and is null without a good one', () => {
  const root = mkRepo({ 'dist/build-info.json': json({ stack: '3.47' }) });
  assert.equal(buildStack(root), '3.47');
  assert.equal(buildStack(mkRepo({})), null);
  assert.equal(buildStack(mkRepo({ 'dist/build-info.json': 'nope' })), null);
  assert.equal(parseBuildStack(json({ stack: 'v3' })), null);
  assert.equal(parseBuildStack(json({ stack: 3 })), null);
  assert.equal(parseBuildStack(null), null);
});

test('ICON_NAME accepts codicon names only', () => {
  for (const ok of ['rocket', 'cloud-upload', 'debug-start', 'x2']) assert.ok(ICON_NAME.test(ok), ok);
  for (const bad of ['', 'Rocket', 'a b', '-a', 'a-', 'a--b', '$(rocket)', 'a/b']) assert.ok(!ICON_NAME.test(bad), bad);
});
