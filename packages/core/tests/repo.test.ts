import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { wireVerScript } from '../src/commands/repo.js';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
const bundledVer = fs.readFileSync(path.join(root, 'assets', 'version.mjs'), 'utf8');

function pf(cwd: string, ...args: string[]) {
  const env = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_NO_TRAVOLTA: '1', PF_HOME: mkRepo({}) };
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}

const demo = () =>
  mkRepo({
    '.git/HEAD': '',
    'package.json': json({ name: 'demo', version: '1.2.0', scripts: { build: 'tsc' } }),
    'pnpm-lock.yaml': '',
  });

test('pf repo installs the pnpm helper and versioning, and wires package.json', () => {
  const dir = demo();
  const r = pf(dir, 'repo');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(dir, 'scripts', 'tasks.mjs')));
  assert.equal(fs.readFileSync(path.join(dir, 'scripts', 'version.mjs'), 'utf8'), bundledVer);
  assert.ok(fs.existsSync(path.join(dir, 'versions.json')));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.ask, 'node scripts/tasks.mjs ask');
  assert.equal(pkg.scripts.ver, 'node scripts/version.mjs');
  assert.equal(pkg.scriptsInfo.Tools.ver, 'List versions and bump commands');
  assert.match(r.out, /installed scripts\/version\.mjs/);
});

test('pf repo --dry-run writes nothing', () => {
  const dir = demo();
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const r = pf(dir, 'repo', '--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(dir, 'scripts')));
  assert.ok(!fs.existsSync(path.join(dir, 'versions.json')));
});

test('pf r updates an older ver CLI copy and leaves a newer one', () => {
  const dir = demo();
  assert.equal(pf(dir, 'r').code, 0);
  const cli = path.join(dir, 'scripts', 'version.mjs');
  const extra = path.join(dir, 'tools', 'version.mjs');
  fs.writeFileSync(cli, bundledVer.replace(/const CLI_VERSION = \d+;/, 'const CLI_VERSION = 1;'));
  fs.mkdirSync(path.dirname(extra));
  fs.writeFileSync(extra, bundledVer.replace(/const CLI_VERSION = \d+;/, 'const CLI_VERSION = 9999;'));
  const r = pf(dir, 'r');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(cli, 'utf8'), bundledVer);
  assert.match(r.out, /updated scripts\/version\.mjs \(revision 1 ->/);
  assert.match(fs.readFileSync(extra, 'utf8'), /CLI_VERSION = 9999/);
  assert.match(r.out, /tools\/version\.mjs is newer than pf's copy/);
});

test('wireVerScript keeps a foreign ver script and uses versions instead', () => {
  const pkg = { scripts: { ver: 'echo mine' }, scriptsInfo: { Tools: {} } };
  wireVerScript(pkg, 'scripts/version.mjs');
  assert.equal(pkg.scripts.ver, 'echo mine');
  assert.equal((pkg.scripts as Record<string, string>).versions, 'node scripts/version.mjs');
  assert.ok('versions' in pkg.scriptsInfo.Tools);
});
