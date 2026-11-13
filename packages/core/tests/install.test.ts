import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allCommands } from '../src/commands/index.js';
import { parseInstallArgs } from '../src/commands/install.js';
import { entriesFor } from '../src/menu.js';
import { buildContext } from '@pulpfixer/kit/context';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

function pf(cwd: string, ...args: string[]) {
  const env = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_HOME: mkRepo({}) };
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, err: r.stderr };
}

const repo = (scripts: Record<string, string>, extra: Record<string, string> = {}) =>
  mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts }), 'pnpm-lock.yaml': '', ...extra });

test('parseInstallArgs takes the target, flags and the args after --', () => {
  assert.deepEqual(parseInstallArgs(['cursor', '--dry-run', '--', '--force']), {
    target: 'cursor',
    options: { dryRun: true, pick: false, deps: false, extra: ['--force'] },
  });
  assert.equal(parseInstallArgs(['--deps']).options.deps, true);
  assert.equal(parseInstallArgs(['--nope']).bad, '--nope');
  assert.equal(parseInstallArgs([]).target, undefined);
});

test('pf il, pf install-local and pf install local run install:local', () => {
  const dir = repo({ 'install:local': 'x', 'install:cursor': 'y' });
  for (const args of [['il'], ['install-local'], ['install', 'local']]) {
    const r = pf(dir, ...args, '--dry-run');
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.err, /pnpm run install:local/);
  }
});

test('pf install <to> runs install:<to>; an unknown target fails and lists the known ones', () => {
  const dir = repo({ 'install:local': 'x', 'install:cursor': 'y' });
  const ok = pf(dir, 'install', 'cursor', '--dry-run');
  assert.equal(ok.code, 0);
  assert.match(ok.err, /pnpm run install:cursor/);
  const bad = pf(dir, 'install', 'nope', '--dry-run');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /no install:nope target/);
  assert.match(bad.err, /pf install cursor/);
});

test('pf i and pf install prefer install:local, and the only target when there is just one', () => {
  const both = repo({ 'install:local': 'x', 'install:cursor': 'y' });
  assert.match(pf(both, 'i', '--dry-run').err, /pnpm run install:local/);
  assert.match(pf(both, 'install', '--dry-run').err, /pnpm run install:local/);
  const one = repo({ 'install:cursor': 'y' });
  assert.match(pf(one, 'i', '--dry-run').err, /pnpm run install:cursor/);
});

test('several targets without local need a choice, and without a terminal fail with the names', () => {
  const dir = repo({ 'install:cursor': 'a', 'install:vscode': 'b' });
  const r = pf(dir, 'i');
  assert.equal(r.code, 2);
  assert.match(r.err, /cursor, vscode/);
  assert.match(pf(dir, 'i', 'vscode', '--dry-run').err, /pnpm run install:vscode/);
});

test('a repo with no install target installs dependencies, and --deps forces that', () => {
  const none = repo({ build: 'x' });
  assert.match(pf(none, 'i', '--dry-run').err, /pnpm install/);
  assert.match(pf(none, 'install', '--dry-run').err, /pnpm install/);
  const has = repo({ 'install:local': 'x' });
  const deps = pf(has, 'install', '--deps', '--dry-run');
  assert.equal(deps.code, 0);
  assert.match(deps.err, /pnpm install/);
  assert.doesNotMatch(deps.err, /install:local/);
});

test('install local never falls back to dependencies', () => {
  const dir = repo({ build: 'x' });
  const r = pf(dir, 'il', '--dry-run');
  assert.equal(r.code, 1);
  assert.match(r.err, /no install:local target/);
  assert.doesNotMatch(r.err, /pnpm install/);
});

test('a pulpfixer.json install:<to> entry is a target', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'pulpfixer.json': json({ commands: { 'install:local': { run: 'echo hi' } } }) });
  assert.match(pf(dir, 'il', '--dry-run').err, /echo hi/);
});

test('install shortcuts exist and do not shadow other commands', () => {
  const names = allCommands().map((c) => c.name);
  for (const n of ['i', 'il', 'install-local', 'install']) assert.ok(names.includes(n), n);
});

test('the menu lists one entry per install target, else the dependency install', () => {
  const withTargets = entriesFor(buildContext(repo({ 'install:local': 'x', 'install:cursor': 'y' }))).map((e) => e.name);
  assert.ok(withTargets.includes('install local'));
  assert.ok(withTargets.includes('install cursor'));
  assert.ok(!withTargets.includes('install'));
  const plain = entriesFor(buildContext(repo({ build: 'x' }))).map((e) => e.name);
  assert.ok(plain.includes('install'));
  const custom = entriesFor(buildContext(mkRepo({ '.git/HEAD': '', 'pulpfixer.json': json({ commands: { 'install:local': { run: 'echo hi' } } }) })));
  assert.equal(custom.filter((e) => e.name === 'install:local').length, 0);
  assert.ok(custom.some((e) => e.name === 'install local'));
});
