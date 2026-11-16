import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cpArgv, listArgv } from '../src/aws.js';
import { findObject, formatSize, normalizePrefix, parseListing, uploadKey } from '../src/exchange.js';
import { mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, '..', 'pulpfixer', 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const LISTING = JSON.stringify([
  ['x/', '2026-01-01T00:00:00+00:00', 0],
  ['x/old.txt', '2026-01-01T10:00:00+00:00', 10],
  ['x/new.tar.gz', '2026-03-01T10:00:00+00:00', 2048],
  ['x/report.pdf', '2026-02-01T10:00:00+00:00', 5_000_000],
]);

test('parseListing sorts newest first, drops folder markers and strips the prefix', () => {
  const objs = parseListing(LISTING, 'x/');
  assert.deepEqual(objs.map((o) => o.name), ['new.tar.gz', 'report.pdf', 'old.txt']);
  assert.equal(objs[0]!.key, 'x/new.tar.gz');
  assert.deepEqual(parseListing('', ''), []);
  assert.deepEqual(parseListing('null', ''), []);
});

test('findObject matches exact, then case-insensitive, then a unique substring', () => {
  const objs = parseListing(LISTING, 'x/');
  assert.equal((findObject(objs, 'old.txt') as { object: { key: string } }).object.key, 'x/old.txt');
  assert.equal((findObject(objs, 'REPORT.PDF') as { object: { key: string } }).object.key, 'x/report.pdf');
  assert.equal((findObject(objs, 'tar') as { object: { key: string } }).object.key, 'x/new.tar.gz');
  assert.equal(findObject(objs, 'nope').kind, 'none');
  assert.equal(findObject(objs, '.').kind, 'many');
});

test('keys, prefixes and sizes', () => {
  assert.equal(normalizePrefix('/a/b'), 'a/b/');
  assert.equal(normalizePrefix(''), '');
  assert.equal(uploadKey('x/', '/tmp/dir/file.txt'), 'x/file.txt');
  assert.equal(uploadKey('x/', '/tmp/dir/file.txt', 'other.txt'), 'x/other.txt');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
});

test('aws argv builders pass the profile and region', () => {
  assert.deepEqual(cpArgv('a', 's3://b/k', { profile: 'exchange', region: 'eu-west-1' }), ['aws', 's3', 'cp', 'a', 's3://b/k', '--profile', 'exchange', '--region', 'eu-west-1']);
  assert.ok(listArgv('b', 'x/', { profile: 'exchange' }).join(' ').includes('--prefix x/ --query'));
});

// ---- CLI with a fake aws on PATH ----

function fakeAws(): { bin: string; log: string } {
  const dir = mkRepo({});
  const log = path.join(dir, 'calls.log');
  const script = `#!/bin/sh
echo "$@" >> "${log}"
case "$2" in
  list-objects-v2) printf '%s' '${LISTING}' ;;
  *) ;;
esac
`;
  fs.writeFileSync(path.join(dir, 'aws'), script, { mode: 0o755 });
  return { bin: dir, log };
}

function pf(cwd: string, env: Record<string, string>, ...args: string[]) {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', ...env };
  delete e.FORCE_COLOR;
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('pf s3 and pf dl without a bucket explain how to set one', () => {
  const r = pf(mkRepo({ 'a.txt': 'hi' }), { PF_HOME: mkRepo({}) }, 's3', 'a.txt');
  assert.equal(r.code, 2);
  assert.match(r.err, /no exchange bucket set/);
});

test('pf s3 --setup saves the config and pf s3 uploads with the exchange profile', () => {
  const home = mkRepo({});
  const fake = fakeAws();
  const env = { PF_HOME: home, PATH: `${fake.bin}${path.delimiter}${process.env.PATH}` };
  const cwd = mkRepo({ 'a.txt': 'hi' });
  const setup = pf(cwd, env, 's3', '--setup', '--bucket', 'my-bucket', '--prefix', 'x');
  assert.equal(setup.code, 0);
  assert.match(setup.out, /my-bucket/);
  assert.match(setup.out, /exchange/);

  const up = pf(cwd, env, 's3', 'a.txt');
  assert.equal(up.code, 0, up.err);
  assert.match(fs.readFileSync(fake.log, 'utf8'), /s3 cp a\.txt s3:\/\/my-bucket\/x\/a\.txt --profile exchange/);

  const dry = pf(cwd, env, 's3', 'a.txt', '--dry-run');
  assert.match(dry.err, /would run aws s3 cp/);
});

test('pf dl lists newest first when piped, and downloads by name', () => {
  const home = mkRepo({});
  const fake = fakeAws();
  const env = { PF_HOME: home, PF_EXCHANGE_BUCKET: 'my-bucket', PF_EXCHANGE_PREFIX: 'x', PATH: `${fake.bin}${path.delimiter}${process.env.PATH}` };
  const cwd = mkRepo({});
  const list = pf(cwd, env, 'dl');
  assert.equal(list.code, 0, list.err);
  const names = list.out.trim().split('\n').map((l) => l.trim().split(/\s+/).pop());
  assert.deepEqual(names, ['new.tar.gz', 'report.pdf', 'old.txt']);

  const dl = pf(cwd, env, 'dl', 'report');
  assert.equal(dl.code, 0, dl.err);
  const calls = fs.readFileSync(fake.log, 'utf8');
  assert.match(calls, /s3 cp s3:\/\/my-bucket\/x\/report\.pdf \S+\/report\.pdf --profile exchange/);

  const missing = pf(cwd, env, 'dl', 'zzz');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no file matching/);
});
