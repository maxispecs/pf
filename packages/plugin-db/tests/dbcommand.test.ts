import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registerDbDrivers } from '@pulpfixer/kit/db';
import { dbCommand, parseField } from '../src/commands/db.js';
import { sqliteDriver } from '../src/drivers/sqlite.js';
import { connect } from '../src/client.js';
import { connectionsPath, loadConnections } from '../src/store.js';
import { setKeychain } from '../src/secrets.js';
import { capture, ctx, freshHome, installFake, memoryKeychain } from './helpers.js';

const pf = (...args: string[]) => capture(() => dbCommand.run(ctx(), args));

test('add with flags saves the values and only a reference to the secret', async () => {
  freshHome();
  const d = installFake();
  process.env.BILLING_PW = 'hunter2';
  const r = await pf('add', 'billing', '--driver', 'fake', '--host', 'db.internal', '--port', '3307', '--secret-from', 'env:BILLING_PW');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /saved connection/);
  // The check ran with the secret resolved...
  assert.equal(d.connects[0]!.params.password, 'hunter2');
  assert.deepEqual(d.log.map((q) => q.text), ['SELECT 1']);
  // ...and the file holds the reference only.
  const file = fs.readFileSync(connectionsPath(), 'utf8');
  assert.ok(!file.includes('hunter2'));
  assert.deepEqual(loadConnections().billing, {
    driver: 'fake',
    form: 'params',
    params: { host: 'db.internal', port: 3307, ssl: false },
    secrets: { password: { from: 'env', name: 'BILLING_PW' } },
  });
  assert.equal(fs.statSync(connectionsPath()).mode & 0o777, 0o600);
});

test('the form is picked from the flags given, and a secret never comes from a flag', async () => {
  freshHome();
  installFake();
  process.env.FAKE_DSN = 'fake://u:p@h/db';
  const ok = await pf('add', 'viadsn', '--driver', 'fake', '--secret-from', 'env:FAKE_DSN', '--form', 'dsn');
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(loadConnections().viadsn!.form, 'dsn');

  const refused = await pf('add', 'x', '--driver', 'fake', '--form', 'dsn', '--dsn', 'fake://u:secret@h/db');
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /secret/);
  assert.ok(!refused.stderr.includes('u:secret'));
  assert.equal(loadConnections().x, undefined);
});

test('add without a terminal needs a name, the required values and a secret source', async () => {
  freshHome();
  installFake();
  assert.equal((await pf('add', '--driver', 'fake')).code, 2);
  const noSecret = await pf('add', 'dsnonly', '--driver', 'fake', '--form', 'dsn');
  assert.equal(noSecret.code, 2);
  assert.match(noSecret.stderr, /--secret-from/);
  const badName = await pf('add', 'Bad Name', '--driver', 'fake');
  assert.equal(badName.code, 2);
  const unknown = await pf('add', 'x', '--driver', 'fake', '--bogus', '1');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown option --bogus/);
  const missingDriver = await pf('add', 'x', '--driver', 'mysql');
  assert.equal(missingDriver.code, 1);
  assert.match(missingDriver.stderr, /pf plugin install db-mysql/);
});

test('a failed check is not saved; --no-test skips it', async () => {
  freshHome();
  const d = installFake();
  d.respond = () => {
    throw new Error('connection refused');
  };
  const failed = await pf('add', 'down', '--driver', 'fake');
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /connection refused/);
  assert.equal(loadConnections().down, undefined);
  const skipped = await pf('add', 'down', '--driver', 'fake', '--no-test');
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.ok(loadConnections().down);
});

test('replacing a connection needs --yes without a terminal', async () => {
  freshHome();
  installFake();
  assert.equal((await pf('add', 'a', '--driver', 'fake', '--host', 'one')).code, 0);
  const refused = await pf('add', 'a', '--driver', 'fake', '--host', 'two');
  assert.equal(refused.code, 1);
  assert.equal(loadConnections().a!.params.host, 'one');
  assert.equal((await pf('add', 'a', '--driver', 'fake', '--host', 'two', '--yes')).code, 0);
  assert.equal(loadConnections().a!.params.host, 'two');
});

test('list shows connections without secrets, as a table or JSON', async () => {
  freshHome();
  installFake();
  assert.match((await pf('list')).stdout, /No database connections/);
  process.env.LIST_PW = 'topsecret';
  await pf('add', 'one', '--driver', 'fake', '--host', 'h1', '--secret-from', 'env:LIST_PW');
  const text = await pf();
  assert.equal(text.code, 0);
  assert.match(text.stdout, /one/);
  assert.match(text.stdout, /h1:3306/);
  assert.match(text.stdout, /password: env:LIST_PW/);
  assert.ok(!text.stdout.includes('topsecret'));
  const j = JSON.parse((await pf('list', '--json')).stdout) as { name: string; driver: string }[];
  assert.deepEqual(j.map((c) => [c.name, c.driver]), [['one', 'fake']]);
});

test('keychain secrets are stored by the keychain, and removed with the connection', async () => {
  freshHome();
  installFake();
  const k = memoryKeychain();
  setKeychain(k);
  // Saving to the keychain asks on the terminal, so without one it is refused.
  const refused = await pf('add', 'kc', '--driver', 'fake', '--secret-from', 'keychain');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /needs a terminal/);
  assert.equal(k.items.size, 0);

  // A connection that was saved earlier reads it back.
  k.items.set('kc.password', 'from-keychain');
  const d = installFake();
  fs.mkdirSync(connectionsPath().replace(/connections\.json$/, ''), { recursive: true });
  fs.writeFileSync(connectionsPath(), JSON.stringify({ version: 1, connections: { kc: { driver: 'fake', form: 'params', params: { host: 'h' }, secrets: { password: { from: 'keychain' } } } } }));
  const db = await connect('kc');
  assert.equal(d.connects[0]!.params.password, 'from-keychain');
  await db.close();

  const gone = await pf('remove', 'kc', '--yes');
  assert.equal(gone.code, 0);
  assert.equal(k.items.size, 0);
  assert.deepEqual(loadConnections(), {});
});

test('remove asks first, and test runs SELECT 1', async () => {
  freshHome();
  const d = installFake();
  await pf('add', 'solo', '--driver', 'fake');
  assert.equal((await pf('remove', 'solo')).code, 1);
  assert.ok(loadConnections().solo);
  d.log.length = 0;
  const t = await pf('test');
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stderr, /solo works/);
  assert.deepEqual(d.log.map((q) => q.text), ['SELECT 1']);
  assert.equal((await pf('remove', 'solo', '--yes')).code, 0);
  assert.equal((await pf('test', 'solo')).code, 1);
});

test('drivers lists built-in, installed and installable ones', async () => {
  freshHome();
  installFake();
  registerDbDrivers([sqliteDriver]);
  const r = await pf('drivers');
  assert.match(r.stdout, /fake.*installed/);
  assert.match(r.stdout, /sqlite.*built in/);
  assert.match(r.stdout, /pf plugin install db-postgres/);
  assert.doesNotMatch(r.stdout, /db-sqlite/);
});

test('without a terminal a lone built-in driver is picked, and an unknown driver points to pf db drivers', async () => {
  freshHome();
  registerDbDrivers([sqliteDriver]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-db-sqlite-')), 'data.db');
  const r = await pf('add', 'local', '--path', file, '--no-test');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadConnections().local!.driver, 'sqlite');
  const missing = await pf('add', 'x', '--driver', 'oracle');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /pf db drivers/);
  const known = await pf('add', 'x', '--driver', 'postgres');
  assert.match(known.stderr, /pf plugin install db-postgres/);
});

test('an unreadable connections file is reported, never replaced', async () => {
  freshHome();
  installFake();
  fs.mkdirSync(connectionsPath().replace(/connections\.json$/, ''), { recursive: true });
  fs.writeFileSync(connectionsPath(), '{ not json');
  const r = await pf('add', 'x', '--driver', 'fake');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(connectionsPath(), 'utf8'), '{ not json');
});

test('parseField reads numbers, booleans and paths', () => {
  const f = (kind: 'number' | 'boolean' | 'path' | 'text') => ({ key: 'k', label: 'K', kind });
  assert.deepEqual(parseField(f('number'), '5432'), { value: 5432 });
  assert.deepEqual(parseField(f('number'), 'abc'), { error: 'K must be a whole number' });
  assert.deepEqual(parseField(f('boolean'), 'yes'), { value: true });
  assert.deepEqual(parseField(f('boolean'), 'false'), { value: false });
  assert.deepEqual(parseField(f('path'), ':memory:'), { value: ':memory:' });
  assert.equal(parseField(f('text'), '  '), null);
  const p = parseField(f('path'), 'data.db');
  assert.ok(p && 'value' in p && String(p.value).startsWith('/'));
});
