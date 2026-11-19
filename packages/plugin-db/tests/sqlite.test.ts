import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateDbDriver } from '@pulpfixer/kit/db';
import { bindValue, runStatement, sqliteDriver } from '../src/drivers/sqlite.js';
import { dbPlugin } from '../src/index.js';

const hasSqlite = (() => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
})();
const q = (text: string, ...values: unknown[]) => ({ text, values });

test('the db plugin ships the SQLite driver', () => {
  assert.equal(dbPlugin.api, 2);
  assert.deepEqual(dbPlugin.dbDrivers?.map((d) => d.id), ['sqlite']);
  assert.equal(validateDbDriver(sqliteDriver), null);
});

test('bindValue converts what SQLite cannot take and refuses the rest', () => {
  assert.equal(bindValue(true), 1);
  assert.equal(bindValue(false), 0);
  assert.equal(bindValue(undefined), null);
  assert.equal(bindValue(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(bindValue(5), 5);
  assert.throws(() => bindValue({}), /cannot bind/);
});

test('runStatement picks all() for statements that return rows and run() for the rest', () => {
  const calls: string[] = [];
  const rows = { columns: () => [{}], all: (...v: unknown[]) => (calls.push(`all ${v.join()}`), [{ a: 1 }]), run: () => ({ changes: 0, lastInsertRowid: 0 }) };
  assert.deepEqual(runStatement(rows as never, q('SELECT ?', 5)), { rows: [{ a: 1 }] });
  const write = { columns: () => [], all: () => [], run: () => ({ changes: 2n, lastInsertRowid: 9n }) };
  assert.deepEqual(runStatement(write as never, q('INSERT INTO t VALUES (1)')), { rows: [], affected: 2, insertId: 9 });
  assert.deepEqual(runStatement(write as never, q('UPDATE t SET a = 1')), { rows: [], affected: 2 });
  assert.deepEqual(calls, ['all 5']);
});

test('describe never shows more than the file', () => {
  assert.equal(sqliteDriver.describe('file', { path: '/x/data.db', readonly: true }), '/x/data.db (read-only)');
});

test('a real database file: create, insert, query, transaction, read-only', { skip: !hasSqlite && 'needs Node 22.13+' }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sqlite-')), 'data.db');
  const s = await sqliteDriver.connect('file', { path: file });
  await s.execute(q('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, ok INTEGER)'));
  const ins = await s.execute(q('INSERT INTO t (name, ok) VALUES (?, ?)', 'a', true));
  assert.deepEqual(ins, { rows: [], affected: 1, insertId: 1 });
  assert.deepEqual((await s.execute(q('SELECT id, name, ok FROM t WHERE name = ?', 'a'))).rows, [{ id: 1, name: 'a', ok: 1 }]);
  assert.deepEqual((await s.execute(q('INSERT INTO t (name) VALUES (?) RETURNING id', 'b'))).rows, [{ id: 2 }]);

  await assert.rejects(s.transaction(async (tx) => {
    await tx.execute(q('INSERT INTO t (name) VALUES (?)', 'gone'));
    throw new Error('stop');
  }), /stop/);
  assert.equal((await s.execute(q('SELECT COUNT(*) AS n FROM t'))).rows[0]!.n, 2);
  await s.transaction(async (tx) => void (await tx.execute(q('INSERT INTO t (name) VALUES (?)', 'kept'))));
  assert.equal((await s.execute(q('SELECT COUNT(*) AS n FROM t'))).rows[0]!.n, 3);
  await s.close();

  const ro = await sqliteDriver.connect('file', { path: file, readonly: true });
  assert.equal((await ro.execute(q('SELECT COUNT(*) AS n FROM t'))).rows[0]!.n, 3);
  await assert.rejects(ro.execute(q('INSERT INTO t (name) VALUES (?)', 'x')), /readonly/i);
  await ro.close();
});
