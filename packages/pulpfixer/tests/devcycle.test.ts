import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { changesSinceBump, findCheckout, planBumps, publishable, shipsChange, suggestCommitMessage, type CyclePackage } from '../src/devcycle.js';
import { buildContext } from '@pulpfixer/kit/context';
import { localEntries } from '../src/local.js';
import { entriesFor } from '../src/menu.js';
import { json, mkRepo } from './helpers.js';

const pkg = (name: string, over: Partial<CyclePackage> = {}): CyclePackage => ({
  name,
  rel: `packages/${name}`,
  local: '1.0.0',
  published: '1.0.0',
  changes: [],
  ...over,
});

test('tests and docs never need a version bump', () => {
  assert.equal(shipsChange('packages/kit/src/util.ts'), true);
  assert.equal(shipsChange('packages/kit/tests/util.test.ts'), false);
  assert.equal(shipsChange('packages/kit/README.md'), false);
});

test('nothing changed: nothing to bump', () => {
  assert.deepEqual(planBumps([pkg('@pulpfixer/kit'), pkg('pulpfixer')]), []);
});

test('a changed, already published package is bumped together with core', () => {
  const plan = planBumps([pkg('@pulpfixer/kit', { changes: ['packages/kit/src/a.ts'] }), pkg('pulpfixer')]);
  assert.deepEqual(plan.map((b) => b.pkg.name), ['@pulpfixer/kit', 'pulpfixer']);
});

test('a preset is bumped alone: core does not pin presets', () => {
  const plan = planBumps([pkg('@pulpfixer/preset-cursor', { changes: ['packages/preset-cursor/preset.json'] }), pkg('pulpfixer')]);
  assert.deepEqual(plan.map((b) => b.pkg.name), ['@pulpfixer/preset-cursor']);
  const ahead = planBumps([pkg('@pulpfixer/preset-cursor', { local: '1.1.0' }), pkg('pulpfixer')]);
  assert.deepEqual(ahead, []);
});

test('a database driver is bumped alone too: core does not pin @pulpfixer/db-*', () => {
  const plan = planBumps([pkg('@pulpfixer/db-mysql', { changes: ['packages/db-mysql/src/index.ts'] }), pkg('pulpfixer')]);
  assert.deepEqual(plan.map((b) => b.pkg.name), ['@pulpfixer/db-mysql']);
  assert.deepEqual(planBumps([pkg('@pulpfixer/db-postgres', { local: '1.1.0' }), pkg('pulpfixer')]), []);
  // plugin-db is a built-in plugin: core pins it and goes along.
  const core = planBumps([pkg('@pulpfixer/plugin-db', { changes: ['packages/plugin-db/src/sql.ts'] }), pkg('pulpfixer')]);
  assert.deepEqual(core.map((b) => b.pkg.name), ['@pulpfixer/plugin-db', 'pulpfixer']);
});

test('a suite extension is bumped alone too: core does not pin @pulpfixer/ext-*', () => {
  const plan = planBumps([pkg('@pulpfixer/ext-bg-tone', { changes: ['packages/ext-bg-tone/src/apply.ts'] }), pkg('pulpfixer')]);
  assert.deepEqual(plan.map((b) => b.pkg.name), ['@pulpfixer/ext-bg-tone']);
  assert.deepEqual(planBumps([pkg('@pulpfixer/ext-bg-tone', { local: '1.1.0' }), pkg('pulpfixer')]), []);
  assert.deepEqual(planBumps([pkg('@pulpfixer/suite', { changes: ['packages/suite/suite.json'] }), pkg('pulpfixer')]).map((b) => b.pkg.name), ['@pulpfixer/suite']);
  assert.deepEqual(
    planBumps([pkg('@pulpfixer/template-query-package', { changes: ['packages/template-query-package/template.json'] }), pkg('pulpfixer')]).map((b) => b.pkg.name),
    ['@pulpfixer/template-query-package'],
  );
});

test('core alone changing bumps only core', () => {
  const plan = planBumps([pkg('@pulpfixer/kit'), pkg('pulpfixer', { changes: ['packages/pulpfixer/src/x.ts'] })]);
  assert.deepEqual(plan.map((b) => b.pkg.name), ['pulpfixer']);
});

test('test-only changes do not bump', () => {
  assert.deepEqual(planBumps([pkg('pulpfixer', { changes: ['packages/pulpfixer/tests/a.test.ts'] })]), []);
});

test('a package already bumped (ahead of the registry) is not bumped again', () => {
  const kit = pkg('@pulpfixer/kit', { local: '1.1.0', changes: ['packages/kit/src/a.ts'] });
  const core = pkg('pulpfixer', { local: '1.1.0' });
  assert.deepEqual(planBumps([kit, core]), []);
  assert.deepEqual(publishable([kit, core], []).map((p) => p.name), ['@pulpfixer/kit', 'pulpfixer']);
});

test('an ahead dependency pulls core along', () => {
  const kit = pkg('@pulpfixer/kit', { local: '1.1.0' });
  const plan = planBumps([kit, pkg('pulpfixer')]);
  assert.deepEqual(plan.map((b) => b.pkg.name), ['pulpfixer']);
});

test('an unreadable registry is never bumped automatically', () => {
  assert.deepEqual(planBumps([pkg('pulpfixer', { published: null, changes: ['packages/pulpfixer/src/x.ts'] })]), []);
});

test('changesSinceBump sees edits after the commit that changed the version', () => {
  const root = mkRepo({ 'packages/kit/package.json': json({ name: 'k', version: '1.0.0' }), 'packages/kit/src/a.ts': 'a\n' });
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  assert.deepEqual(changesSinceBump(root, 'packages/kit'), []);
  fs.writeFileSync(path.join(root, 'packages/kit/src/a.ts'), 'changed\n');
  fs.writeFileSync(path.join(root, 'packages/kit/src/b.ts'), 'new\n');
  assert.deepEqual(changesSinceBump(root, 'packages/kit').sort(), ['packages/kit/src/a.ts', 'packages/kit/src/b.ts']);
  git('add', '-A');
  git('commit', '-q', '-m', 'two');
  assert.equal(changesSinceBump(root, 'packages/kit').length, 2);
  fs.writeFileSync(path.join(root, 'packages/kit/package.json'), json({ name: 'k', version: '1.1.0' }));
  git('commit', '-q', '-am', 'bump');
  assert.deepEqual(changesSinceBump(root, 'packages/kit'), []);
});

test('suggestCommitMessage names the packages and files touched', () => {
  const lines = [
    ' M versions.json',
    ' M packages/pulpfixer/package.json',
    ' M packages/pulpfixer/src/devcycle.ts',
    ' M packages/pulpfixer/src/commands/cycle.ts',
    '?? packages/kit/src/ui/text.ts',
  ];
  assert.equal(suggestCommitMessage(lines, '2.9'), 'v2.9: update pulpfixer (devcycle, cycle), kit (text)');
  assert.equal(suggestCommitMessage(['?? packages/kit/src/new.ts'], null), 'add kit (new)');
  assert.equal(suggestCommitMessage([' M versions.json', ' M packages/kit/package.json'], '2.9'), 'v2.9');
  assert.equal(suggestCommitMessage([' M scripts/build.mjs'], '2.9'), 'v2.9: update scripts (build)');
  assert.equal(suggestCommitMessage([' M a.ts', ' M b.ts', ' M c.ts', ' M d.ts'], null), 'update root (a, b, c, +1)');
});

test('the local menu offers the dev cycle', () => {
  const root = mkRepo({ 'package.json': json({ name: 'pf' }) });
  const cycle = localEntries(root).find((e) => e.name === 'cycle');
  assert.ok(cycle);
  assert.equal(cycle.cli, './pf cycle');
});

test('the menu in the checkout root lists the workbench tools in the Agent group', () => {
  const files = {
    'package.json': json({ name: 'pf-checkout' }),
    pf: '#!/bin/sh\n',
    'scripts/release.mjs': '',
    'packages/pulpfixer/package.json': json({ name: 'pulpfixer' }),
    'workbench/pulpfixer.json': json({ commands: { 'wb-new': { run: 'node tools/wb-new/index.mjs', description: 'Start a tool', group: 'Workbench' } } }),
  };
  const root = mkRepo(files);
  const agent = entriesFor(buildContext(root)).find((e) => e.name === 'wb-new');
  assert.ok(agent);
  assert.equal(agent.group, 'Agent');
  assert.equal(agent.summary, 'Start a tool');
  // Elsewhere in the checkout, and in another repo, there is no such entry.
  assert.equal(entriesFor(buildContext(path.join(root, 'workbench'))).some((e) => e.group === 'Agent' && e.name === 'wb-new'), false);
  assert.equal(entriesFor(buildContext(mkRepo({ 'package.json': json({ name: 'other' }) }))).some((e) => e.name === 'wb-new'), false);
});

test('findCheckout finds the pulpfixer checkout from inside it, and nothing elsewhere', () => {
  const dir = mkRepo({
    pf: '#!/bin/sh\n',
    'scripts/release.mjs': '',
    'packages/pulpfixer/package.json': json({ name: 'pulpfixer' }),
    'packages/kit/src/x.ts': '',
  });
  assert.equal(fs.realpathSync(findCheckout(path.join(dir, 'packages', 'kit', 'src'))!), fs.realpathSync(dir));
  assert.equal(findCheckout(mkRepo({ 'package.json': json({ name: 'other' }) })), null);
});
