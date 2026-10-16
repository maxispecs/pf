import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRepo } from '../src/detect/repo.js';
import { json, mkRepo } from './helpers.js';

test('finds the nearest .git ancestor', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'a/b/c.txt': '', 'package.json': json({ name: '@acme/web' }) });
  const repo = findRepo(`${dir}/a/b`)!;
  assert.equal(repo.root, dir);
  assert.equal(repo.name, 'web');
  assert.equal(repo.hasGit, true);
});

test('pf.json marks a repo root and can name it', () => {
  const dir = mkRepo({ 'pf.json': json({ name: 'custom', commands: {} }), 'x/y.txt': '' });
  const repo = findRepo(`${dir}/x`)!;
  assert.equal(repo.root, dir);
  assert.equal(repo.name, 'custom');
  assert.equal(repo.hasConfig, true);
});

test('without git, the current directory counts when it has a project marker', () => {
  const dir = mkRepo({ 'go.mod': 'module x\n' });
  assert.equal(findRepo(dir)!.root, dir);
  assert.equal(findRepo(dir)!.hasGit, false);
});

test('an empty directory outside any repo is not a repo', () => {
  assert.equal(findRepo(mkRepo({})), null);
});
