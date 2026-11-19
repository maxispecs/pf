import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionOptions, mysqlDriver, toResult } from '../src/index.js';

test('the params form maps to mysql2 options and keeps DECIMAL exact', () => {
  const o = connectionOptions('params', { host: 'db', port: 3307, user: 'app', database: 'billing', password: 'pw', ssl: true });
  assert.equal(o.host, 'db');
  assert.equal(o.port, 3307);
  assert.equal(o.password, 'pw');
  assert.deepEqual(o.ssl, {});
  assert.equal(o.decimalNumbers, false);
  assert.equal(o.supportBigNumbers, true);
  const plain = connectionOptions('params', { host: 'db', user: 'app', database: 'billing' });
  assert.equal(plain.port, 3306);
  assert.ok(!('password' in plain) && !('ssl' in plain));
  assert.throws(() => connectionOptions('params', { host: 'db' }), /required/);
});

test('the dsn form uses the uri', () => {
  assert.equal(connectionOptions('dsn', { dsn: 'mysql://u:p@h:3306/d' }).uri, 'mysql://u:p@h:3306/d');
  assert.throws(() => connectionOptions('dsn', {}), /empty/);
});

test('results: rows for reads, a header for writes', () => {
  assert.deepEqual(toResult([{ a: 1 }]), { rows: [{ a: 1 }] });
  assert.deepEqual(toResult({ affectedRows: 2, insertId: 0 }), { rows: [], affected: 2 });
  assert.deepEqual(toResult({ affectedRows: 1, insertId: 14 }), { rows: [], affected: 1, insertId: 14 });
});

test('describe shows no secret', () => {
  assert.equal(mysqlDriver.describe('params', { host: 'db', user: 'app', database: 'billing' }), 'app@db:3306/billing');
  assert.equal(mysqlDriver.describe('dsn', {}), 'connection string');
});

const live = process.env.PF_TEST_MYSQL_URL;
test('live: select against PF_TEST_MYSQL_URL', { skip: !live && 'set PF_TEST_MYSQL_URL to run' }, async () => {
  const s = await mysqlDriver.connect('dsn', { dsn: live! });
  assert.deepEqual((await s.execute({ text: 'SELECT ? AS n', values: [4] })).rows.map((r) => ({ ...r })), [{ n: 4 }]);
  await s.close();
});
