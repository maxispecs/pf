import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { packagedSkillFile } from '../src/skills/packages.js';

// The ver CLI the skill ships (what pf runs and copies into repos): categories and `categorize`.
const CLI = packagedSkillFile('version', 'scripts/version.mjs') as string;

function repo(extra: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ver-cat-'));
  const entry = (version: string) => ({ version, since: '2026-11-01', type: 'node' });
  for (const name of ['kit', 'aws', 'web']) {
    fs.mkdirSync(path.join(root, 'packages', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', name, 'package.json'), `{ "name": "@x/${name}", "version": "1.0.0" }\n`);
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "root", "version": "1.0.0" }\n');
  fs.writeFileSync(
    path.join(root, 'versions.json'),
    `${JSON.stringify(
      { stack: { version: '1.0', since: '2026-11-01' }, packages: { 'packages/aws': entry('1.0'), 'packages/kit': entry('1.0'), 'packages/web': entry('1.0') }, ...extra },
      null,
      2,
    )}\n`,
  );
  return root;
}

function ver(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));

test('category creates, recolors and removes; categorize assigns and clears', () => {
  const root = repo();
  assert.equal(ver(root, 'category', 'core', '--color', '#4AA3FF').code, 0);
  assert.equal(ver(root, 'category', 'plugins').code, 0);
  assert.deepEqual(read(root).categories, { core: { color: '#4aa3ff' }, plugins: {} });
  // Written right after the stack, and the order is the file order.
  assert.deepEqual(Object.keys(read(root)), ['stack', 'categories', 'packages']);

  assert.equal(ver(root, 'categorize', 'core', 'kit', 'packages/web').code, 0);
  assert.equal(read(root).packages['packages/kit'].category, 'core');
  assert.equal(read(root).packages['packages/web'].category, 'core');
  assert.equal(read(root).packages['packages/aws'].category, undefined);

  assert.equal(ver(root, 'category', 'plugins', '--color', '#0f0').code, 0);
  assert.equal(read(root).categories.plugins.color, '#0f0');
  assert.equal(ver(root, 'category', 'plugins', '--color', 'none').code, 0);
  assert.deepEqual(read(root).categories.plugins, {});

  assert.equal(ver(root, 'categorize', '--none', 'kit').code, 0);
  assert.equal(read(root).packages['packages/kit'].category, undefined);

  const removed = ver(root, 'category', 'core', '--remove');
  assert.equal(removed.code, 0);
  assert.match(removed.out, /1 package left/);
  assert.equal(read(root).packages['packages/web'].category, undefined);
  assert.deepEqual(read(root).categories, { plugins: {} });
  // The last one removed drops the key.
  assert.equal(ver(root, 'category', 'plugins', '--remove').code, 0);
  assert.equal('categories' in read(root), false);
});

test('category and categorize refuse bad input and write nothing on a dry run', () => {
  const root = repo({ categories: { core: { color: '#4aa3ff' } } });
  const before = fs.readFileSync(path.join(root, 'versions.json'), 'utf8');
  for (const args of [
    ['category', 'x', '--color', 'red'],
    ['category', 'x', '--color', '#12'],
    ['category', 'nope', '--remove'],
    ['category', 'core', '--remove', '--color', '#fff'],
    ['categorize', 'nope', 'kit'],
    ['categorize', 'core', 'stack'],
    ['categorize', 'core'],
    ['categorize', 'core', 'missing'],
  ]) {
    const r = ver(root, ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /error:/);
  }
  assert.equal(ver(root, 'categorize', 'core', 'kit', '--dry-run').code, 0);
  assert.equal(ver(root, 'category', 'more', '--color', '#fff', '--dry-run').code, 0);
  assert.equal(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'), before);
});

test('a malformed categories key or package category stops the CLI', () => {
  assert.equal(ver(repo({ categories: ['a'] }), 'list').code, 1);
  assert.equal(ver(repo({ categories: { core: { color: 'blue' } } }), 'list').code, 1);
  assert.equal(ver(repo({ categories: { core: null } }), 'list').code, 1);
  const root = repo({ categories: { core: {} } });
  const doc = read(root);
  doc.packages['packages/kit'].category = 3;
  fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify(doc));
  assert.equal(ver(root, 'list').code, 1);
});

test('list groups by category after the featured block, and --json carries the categories', () => {
  const root = repo({ featured: ['packages/web'], categories: { core: { color: '#4aa3ff' }, plugins: {} } });
  const doc = read(root);
  doc.packages['packages/kit'].category = 'core';
  doc.packages['packages/web'].category = 'core';
  doc.packages['packages/aws'].category = 'plugins';
  fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify(doc));

  const json = JSON.parse(ver(root, 'list', '--json').out);
  assert.deepEqual(json.categories, [{ name: 'core', color: '#4aa3ff' }, { name: 'plugins', color: null }]);
  assert.deepEqual(
    json.packages.map((p: { path: string; category: string | null; featured: boolean }) => [p.path, p.category, p.featured]),
    [['packages/web', 'core', true], ['packages/kit', 'core', false], ['packages/aws', 'plugins', false]],
  );
  assert.match(ver(root, 'list').out, /CATEGORY/);
  assert.match(ver(root, 'category').out, /core\s+#4aa3ff\s+2/);

  // Without categories nothing changes: no column, and `category` says there are none.
  const plain = repo();
  assert.doesNotMatch(ver(plain, 'list').out, /CATEGORY/);
  assert.match(ver(plain, 'category').out, /No categories/);
  assert.deepEqual(JSON.parse(ver(plain, 'list', '--json').out).categories, []);
});

test('an undefined package category is a warning and counts as none', () => {
  const root = repo({ categories: { core: {} } });
  const doc = read(root);
  doc.packages['packages/kit'].category = 'ghost';
  fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify(doc));
  const json = JSON.parse(ver(root, 'list', '--json').out);
  assert.equal(json.packages.find((p: { path: string }) => p.path === 'packages/kit').category, null);
  assert.ok(json.warnings.some((w: string) => /ghost/.test(w)));
});

test('a bump keeps categories and the package category', () => {
  const root = repo({ categories: { core: { color: '#4aa3ff' } } });
  assert.equal(ver(root, 'categorize', 'core', 'kit').code, 0);
  assert.equal(ver(root, 'bump', 'kit', 'minor', '--no-hooks').code, 0);
  const doc = read(root);
  assert.equal(doc.packages['packages/kit'].version, '1.1');
  assert.equal(doc.packages['packages/kit'].category, 'core');
  assert.deepEqual(doc.categories, { core: { color: '#4aa3ff' } });
  assert.equal(ver(root, 'feature', 'aws').code, 0);
  assert.deepEqual(Object.keys(read(root)), ['stack', 'featured', 'categories', 'packages']);
  assert.equal(ver(root, '--cli-version').out.trim(), '9');
});

test('the colors in list follow the terminal: 24-bit when it says so, plain without color', () => {
  const root = repo({ categories: { core: { color: '#4aa3ff' } } });
  ver(root, 'categorize', 'core', 'kit');
  const run = (env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [CLI, '--root', root, 'list'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).stdout;
  assert.match(run({ FORCE_COLOR: '1', COLORTERM: 'truecolor' }), /\x1b\[38;2;74;163;255mpackages\/kit/);
  assert.match(run({ FORCE_COLOR: '1', COLORTERM: '' }), /\x1b\[38;5;\d+mpackages\/kit/);
  assert.doesNotMatch(run({ NO_COLOR: '1' }), /\x1b\[/);
});
