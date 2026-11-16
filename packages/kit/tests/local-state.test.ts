import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ensureLocalIgnored, ignoresLocalDir, loadLocalConfig, parseGitPush, setLocalConfigSection } from '../src/local-state.js';
import { mkRepo } from './helpers.js';

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

test('writing the local config creates .pf with a self-ignoring .gitignore', () => {
  const root = mkRepo({});
  assert.deepEqual(loadLocalConfig(root), {});
  const w = setLocalConfigSection(root, 'git', { push: { primary: 'origin', secondary: ['backup'] } });
  assert.deepEqual(w, { ok: true, changed: true });
  assert.equal(read(root, '.pf/.gitignore'), '*\n');
  assert.deepEqual(loadLocalConfig(root), { git: { push: { primary: 'origin', secondary: ['backup'] } } });
  assert.deepEqual(setLocalConfigSection(root, 'git', { push: { primary: 'origin', secondary: ['backup'] } }), { ok: true, changed: false });
});

test('a section value of undefined removes the key; an empty section disappears', () => {
  const root = mkRepo({});
  setLocalConfigSection(root, 'git', { push: { primary: 'a' } });
  setLocalConfigSection(root, 'other', { keep: 1 });
  setLocalConfigSection(root, 'git', { push: undefined });
  const doc = JSON.parse(read(root, '.pf/config.json'));
  assert.equal(doc.git, undefined);
  assert.deepEqual(doc.other, { keep: 1 });
});

test('a dry run writes nothing, and invalid JSON is never overwritten', () => {
  const root = mkRepo({});
  assert.deepEqual(setLocalConfigSection(root, 'git', { push: { primary: 'a' } }, { dryRun: true }), { ok: true, changed: true });
  assert.ok(!fs.existsSync(path.join(root, '.pf')));
  const bad = mkRepo({ '.pf/config.json': '{ nope' });
  const w = setLocalConfigSection(bad, 'git', { push: { primary: 'a' } });
  assert.equal(w.ok, false);
  assert.equal(read(bad, '.pf/config.json'), '{ nope');
  assert.deepEqual(loadLocalConfig(bad), {});
});

test('parseGitPush keeps valid remote names only, without duplicates or the primary', () => {
  assert.deepEqual(parseGitPush({ primary: 'origin', secondary: ['backup', 'backup', 'origin', '--force', 'a b', 3] }), { primary: 'origin', secondary: ['backup'] });
  assert.deepEqual(parseGitPush({ primary: '-x' }), {});
  assert.deepEqual(parseGitPush('nope'), {});
});

test('ensureLocalIgnored adds .pf/ once, keeps the file, and skips a folder without .git', () => {
  const root = mkRepo({ '.git/HEAD': '', '.gitignore': 'node_modules' });
  const first = ensureLocalIgnored(root, { dryRun: true });
  assert.ok(first.ok && first.changed);
  assert.equal(read(root, '.gitignore'), 'node_modules');
  assert.ok(ensureLocalIgnored(root).ok);
  assert.equal(read(root, '.gitignore'), 'node_modules\n.pf/\n');
  const again = ensureLocalIgnored(root);
  assert.ok(again.ok && !again.changed);
  assert.equal(read(root, '.gitignore'), 'node_modules\n.pf/\n');

  const fresh = mkRepo({ '.git/HEAD': '' });
  ensureLocalIgnored(fresh);
  assert.equal(read(fresh, '.gitignore'), '.pf/\n');

  const plain = mkRepo({});
  const r = ensureLocalIgnored(plain);
  assert.ok(r.ok && !r.changed);
  assert.ok(!fs.existsSync(path.join(plain, '.gitignore')));
});

test('ignoresLocalDir recognises the usual spellings', () => {
  for (const t of ['.pf', '.pf/', '/.pf', '/.pf/\n', 'a\n .pf/ \nb']) assert.ok(ignoresLocalDir(t), t);
  for (const t of ['', '.pfx', 'foo/.pf', '# .pf']) assert.ok(!ignoresLocalDir(t), t);
});
