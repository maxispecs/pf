import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateDbDriver } from '@pulpfixer/kit/db';
import { bindValue, runStatement, sqliteDriver, streamStatement } from '../src/drivers/sqlite.js';
import { dbPlugin } from '../src/index.js';

const hasSqlite = (() => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
})();
const q = (text: string, ...values: unknown[]) => ({ text, values });

test('the db plugin ships the SQLite driver', () => {
  assert.equal(dbPlugin.api, 3);
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

test('streamStatement batches rows out of iterate() and refuses a statement that returns none', async () => {
  const stmt = { columns: () => [{}], iterate: function* () { for (let i = 1; i <= 5; i++) yield { n: i }; }, all: () => [], run: () => ({ changes: 0, lastInsertRowid: 0 }) };
  const batches: number[] = [];
  for await (const b of streamStatement(stmt as never, q('SELECT n'), 2)) batches.push(b.length);
  assert.deepEqual(batches, [2, 2, 1]);
  const write = { ...stmt, columns: () => [] };
  await assert.rejects(streamStatement(write as never, q('INSERT INTO t VALUES (1)'), 2).next(), /returns rows/);
});

test('a real database file streams in batches, also inside a transaction', { skip: !hasSqlite && 'needs Node 22.13+' }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sqlite-')), 'data.db');
  const s = await sqliteDriver.connect('file', { path: file });
  await s.execute(q('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)'));
  for (let i = 1; i <= 5; i++) await s.execute(q('INSERT INTO t (name) VALUES (?)', `n${i}`));
  const read = async (session: typeof s, size: number) => {
    const sizes: number[] = [];
    const names: unknown[] = [];
    for await (const b of session.stream!(q('SELECT id, name FROM t WHERE id > ? ORDER BY id', 1), size)) {
      sizes.push(b.length);
      names.push(...b.map((r) => r.name));
    }
    return { sizes, names };
  };
  assert.deepEqual(await read(s, 3), { sizes: [3, 1], names: ['n2', 'n3', 'n4', 'n5'] });
  assert.deepEqual(await s.transaction((tx) => read(tx, 10)), { sizes: [4], names: ['n2', 'n3', 'n4', 'n5'] });
  for await (const b of s.stream!(q('SELECT id FROM t'), 1)) {
    assert.equal(b.length, 1);
    break;
  }
  assert.equal((await s.execute(q('SELECT COUNT(*) AS n FROM t'))).rows[0]!.n, 5);
  await s.close();
});
