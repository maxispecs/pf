import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadRepoConfig, migrateRepoConfig, repoConfigName } from '../src/config.js';
import { findRepo } from '../src/detect/repo.js';
import { json, mkRepo } from './helpers.js';

test('a repo with only a legacy pf.json is still found and read', () => {
  const root = mkRepo({ 'pf.json': json({ name: 'old', commands: { dev: 'node app.js' } }) });
  assert.equal(repoConfigName(root), 'pf.json');
  assert.equal(findRepo(root)?.hasConfig, true);
  assert.equal(findRepo(root)?.name, 'old');
  assert.equal(loadRepoConfig(root).commands.dev?.run, 'node app.js');
});

test('a new repo gets pulpfixer.json, and pulpfixer.json wins over pf.json', () => {
  assert.equal(repoConfigName(mkRepo({})), 'pulpfixer.json');
  const both = mkRepo({ 'pf.json': json({ name: 'old' }), 'pulpfixer.json': json({ name: 'new' }) });
  assert.equal(loadRepoConfig(both).name, 'new');
});

test('migrateRepoConfig renames pf.json unchanged, and a dry run touches nothing', () => {
  const text = json({ id: 'api-1234abcd', commands: { deploy: { run: './tl d', message: true } } });
  const root = mkRepo({ 'pf.json': text });
  assert.deepEqual(migrateRepoConfig(root, { dryRun: true }), { state: 'converted', removed: false });
  assert.ok(fs.existsSync(path.join(root, 'pf.json')));
  assert.deepEqual(migrateRepoConfig(root), { state: 'converted', removed: false });
  assert.ok(!fs.existsSync(path.join(root, 'pf.json')));
  assert.equal(fs.readFileSync(path.join(root, 'pulpfixer.json'), 'utf8'), text);
  assert.deepEqual(migrateRepoConfig(root), { state: 'current' });
  assert.deepEqual(migrateRepoConfig(mkRepo({})), { state: 'none' });
});

test('migrateRepoConfig deletes a pf.json identical to pulpfixer.json and leaves one that differs', () => {
  const same = mkRepo({ 'pf.json': json({ name: 'a' }), 'pulpfixer.json': json({ name: 'a' }) });
  assert.deepEqual(migrateRepoConfig(same), { state: 'converted', removed: true });
  assert.ok(!fs.existsSync(path.join(same, 'pf.json')));

  const differ = mkRepo({ 'pf.json': json({ name: 'a' }), 'pulpfixer.json': json({ name: 'b' }) });
  assert.deepEqual(migrateRepoConfig(differ), { state: 'both' });
  assert.ok(fs.existsSync(path.join(differ, 'pf.json')));
  assert.equal(loadRepoConfig(differ).name, 'b');
});
