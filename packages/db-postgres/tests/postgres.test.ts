import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientConfig, postgresDriver, toResult } from '../src/index.js';

test('the params form maps to pg options; the password is only set when given', () => {
  assert.deepEqual(clientConfig('params', { host: 'db', port: 6543, user: 'app', database: 'main', password: 'pw', ssl: true }), {
    host: 'db', port: 6543, user: 'app', database: 'main', password: 'pw', ssl: true,
  });
  assert.deepEqual(clientConfig('params', { host: 'db', user: 'app', database: 'main' }), { host: 'db', port: 5432, user: 'app', database: 'main' });
  assert.throws(() => clientConfig('params', { host: 'db' }), /required/);
});

test('the dsn form passes the connection string through', () => {
  assert.deepEqual(clientConfig('dsn', { dsn: 'postgres://u:p@h/d' }), { connectionString: 'postgres://u:p@h/d' });
  assert.throws(() => clientConfig('dsn', { dsn: '' }), /empty/);
});

test('results: rows for reads, affected counts for writes', () => {
  assert.deepEqual(toResult({ rows: [{ a: 1 }], rowCount: 1, command: 'SELECT' }), { rows: [{ a: 1 }] });
  assert.deepEqual(toResult({ rows: [], rowCount: 3, command: 'UPDATE' }), { rows: [], affected: 3 });
  assert.deepEqual(toResult({ rows: [{ id: 5 }], rowCount: 1, command: 'INSERT' }), { rows: [{ id: 5 }], affected: 1 });
});

test('the forms ask for a secret password and a secret dsn, and describe shows no secret', () => {
  const secrets = postgresDriver.forms.flatMap((f) => f.fields).filter((f) => f.kind === 'secret').map((f) => f.key);
  assert.deepEqual(secrets, ['password', 'dsn']);
  assert.equal(postgresDriver.describe('params', { host: 'db', port: 5432, user: 'app', database: 'main' }), 'app@db:5432/main');
  assert.equal(postgresDriver.describe('dsn', {}), 'connection string');
});

const live = process.env.PF_TEST_PG_URL;
test('live: select against PF_TEST_PG_URL', { skip: !live && 'set PF_TEST_PG_URL to run' }, async () => {
  const s = await postgresDriver.connect('dsn', { dsn: live! });
  assert.deepEqual((await s.execute({ text: 'SELECT $1::int AS n', values: [4] })).rows, [{ n: 4 }]);
  await s.close();
});
