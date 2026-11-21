import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LIB_FILES, monorepoVersions, planRepo, repoFiles, writeRepo } from './promote.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-promote-'));
const VERSIONS = { '@pulpfixer/kit': '^1.2.3', '@pulpfixer/plugin-db': '^2.0.0', '@pulpfixer/db-dynamodb': '^3.1.0' };

/** A fake workbench: scratch/<name>/index.mjs (plus a sibling file) and a lib/ with the helpers. */
function fakeWorkbench(name = 'fix-users') {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'scratch', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'scratch', name, 'index.mjs'), '// tool\n');
  fs.writeFileSync(path.join(root, 'scratch', name, 'ids.json'), '[1]');
  fs.mkdirSync(path.join(root, 'lib'));
  for (const f of LIB_FILES) fs.writeFileSync(path.join(root, 'lib', f), `// ${f}\n`);
  return { root, scratchRoot: path.join(root, 'scratch'), libDir: path.join(root, 'lib'), repos: path.join(root, 'repos') };
}

test('repoFiles: manifest, pf command, ignore rules and the registry file', () => {
  const files = Object.fromEntries(repoFiles({ name: 'fix-users', description: 'Fix users', versions: VERSIONS }).map((f) => [f.path, f.content]));
  const pkg = JSON.parse(files['package.json']);
  assert.equal(pkg.name, 'fix-users');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.dependencies, VERSIONS);
  assert.deepEqual(JSON.parse(files['pulpfixer.json']), {
    name: 'fix-users',
    commands: { 'fix-users': { run: 'node tools/fix-users/index.mjs', description: 'Fix users', group: 'Tools' } },
  });
  assert.match(files['.gitignore'], /^files\/\*$/m);
  assert.match(files['.gitignore'], /^!files\/\.gitkeep$/m);
  assert.match(files['.npmrc'], /_authToken=\$\{NPM_TOKEN\}/, 'the token is a placeholder, never a value');
  assert.ok('files/.gitkeep' in files);
  assert.match(files['README.md'], /pf fix-users --live/);
});

test('monorepoVersions reads the packages and refuses a missing one', () => {
  const packages = tmp();
  for (const [dir, v] of [['kit', '6.13.0'], ['plugin-db', '1.4.0'], ['db-dynamodb', '1.0.0']]) {
    fs.mkdirSync(path.join(packages, dir));
    fs.writeFileSync(path.join(packages, dir, 'package.json'), JSON.stringify({ version: v }));
  }
  assert.deepEqual(monorepoVersions(packages), { '@pulpfixer/kit': '^6.13.0', '@pulpfixer/plugin-db': '^1.4.0', '@pulpfixer/db-dynamodb': '^1.0.0' });
  fs.rmSync(path.join(packages, 'plugin-db'), { recursive: true });
  assert.throws(() => monorepoVersions(packages), /plugin-db/);
  // the real monorepo has them
  assert.match(monorepoVersions(path.join(here, '..', '..', 'packages'))['@pulpfixer/kit'], /^\^\d+\.\d+\.\d+$/);
});

test('planRepo writes nothing and refuses a bad name, a missing scratch tool and an existing target', () => {
  const wb = fakeWorkbench();
  const base = { name: 'fix-users', description: '', scratchRoot: wb.scratchRoot, libDir: wb.libDir, target: path.join(wb.repos, 'fix-users'), versions: VERSIONS };
  const plan = planRepo(base);
  assert.equal(fs.existsSync(wb.repos), false);
  assert.equal(plan.target, base.target);
  assert.ok(plan.files.length >= 5);
  assert.deepEqual(plan.copies.map((c) => c.to), [path.join('tools', 'fix-users'), ...LIB_FILES.map((f) => path.join('lib', f))]);
  assert.match(JSON.parse(plan.files.find((f) => f.path === 'pulpfixer.json').content).commands['fix-users'].description, /promoted/, 'the description is optional');

  assert.throws(() => planRepo({ ...base, name: '../x' }), /not a valid tool name/);
  assert.throws(() => planRepo({ ...base, name: 'nothing' }), /not found/);
  fs.mkdirSync(base.target, { recursive: true });
  assert.throws(() => planRepo(base), /already exists/);
  fs.rmSync(base.target, { recursive: true });
  fs.rmSync(path.join(wb.libDir, 'guard.mjs'));
  assert.throws(() => planRepo(base), /guard\.mjs is missing/);
});

test('writeRepo builds the repo and removes the scratch tool only afterwards', () => {
  const wb = fakeWorkbench();
  const target = path.join(wb.repos, 'fix-users');
  const plan = planRepo({ name: 'fix-users', description: 'Fix users', scratchRoot: wb.scratchRoot, libDir: wb.libDir, target, versions: VERSIONS });
  writeRepo(plan, { removeFrom: path.join(wb.scratchRoot, 'fix-users') });
  for (const f of ['package.json', 'pulpfixer.json', '.gitignore', '.npmrc', 'README.md', 'files/.gitkeep', 'tools/fix-users/index.mjs', 'tools/fix-users/ids.json', ...LIB_FILES.map((l) => `lib/${l}`)]) {
    assert.ok(fs.existsSync(path.join(target, ...f.split('/'))), f);
  }
  assert.equal(fs.existsSync(path.join(wb.scratchRoot, 'fix-users')), false, 'the scratch folder is gone');
  assert.equal(fs.existsSync(path.join(wb.root, 'files')), false, 'files/<name> is never touched');
});

test('a failed write removes the half-made repo and keeps the scratch tool', () => {
  const wb = fakeWorkbench();
  const target = path.join(wb.repos, 'fix-users');
  const plan = planRepo({ name: 'fix-users', description: 'x', scratchRoot: wb.scratchRoot, libDir: wb.libDir, target, versions: VERSIONS });
  fs.rmSync(path.join(wb.libDir, 'db.mjs')); // vanishes between plan and write
  assert.throws(() => writeRepo(plan, { removeFrom: path.join(wb.scratchRoot, 'fix-users') }));
  assert.equal(fs.existsSync(target), false);
  assert.ok(fs.existsSync(path.join(wb.scratchRoot, 'fix-users', 'index.mjs')));
});

test('wb-promote usage errors are exit 2 and nothing is written', () => {
  const script = path.join(here, '..', 'tools', 'wb-promote', 'index.mjs');
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.equal(run('x').status, 2, 'the default mode needs a description');
  assert.equal(run('x', '--bogus', 'd').status, 2);
  assert.equal(run('x', 'desc', '--no-git').status, 2, '--no-git only goes with --repo');
  const missing = run('definitely-not-here', '--repo', '--dry-run');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
});
