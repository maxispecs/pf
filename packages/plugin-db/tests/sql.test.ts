import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, conditions, deleteFrom, insert, sql, SqlError, update, where } from '../src/sql.js';

test('values become placeholders per dialect, never text', () => {
  const evil = "x'; DROP TABLE orders; --";
  const q = sql`SELECT * FROM ${sql.id('orders')} WHERE month = ${evil} AND n > ${5}`;
  assert.deepEqual(compile(q, 'postgres'), { text: 'SELECT * FROM "orders" WHERE month = $1 AND n > $2', values: [evil, 5] });
  assert.deepEqual(compile(q, 'mysql'), { text: 'SELECT * FROM `orders` WHERE month = ? AND n > ?', values: [evil, 5] });
  assert.deepEqual(compile(q, 'sqlite'), { text: 'SELECT * FROM "orders" WHERE month = ? AND n > ?', values: [evil, 5] });
});

test('identifiers are quoted and escaped, a trailing star stays bare', () => {
  assert.equal(compile(sql`SELECT ${sql.id('t.*')}, ${sql.id('t.a')} FROM ${sql.id('t')}`, 'mysql').text, 'SELECT `t`.*, `t`.`a` FROM `t`');
  assert.equal(compile(sql.id('we"ird'), 'postgres').text, '"we""ird"');
  assert.equal(compile(sql.id('we`ird'), 'mysql').text, '`we``ird`');
  assert.throws(() => sql.id(''), SqlError);
  assert.throws(() => sql.id('a..b'), SqlError);
});

test('fragments nest, join and list', () => {
  const part = sql`a = ${1}`;
  const q = sql`SELECT 1 WHERE ${part} AND b IN (${sql.list([2, 3])}) AND ${sql.join([sql`c = ${4}`, sql`d = ${5}`], ' OR ')}`;
  assert.deepEqual(compile(q, 'postgres'), { text: 'SELECT 1 WHERE a = $1 AND b IN ($2, $3) AND c = $4 OR d = $5', values: [1, 2, 3, 4, 5] });
  assert.equal(compile(sql`x ${sql.raw('FOR UPDATE')}`, 'sqlite').text, 'x FOR UPDATE');
});

test('mistakes fail loudly: undefined, a bare array, an empty list', () => {
  assert.throws(() => sql`a = ${undefined}`, /undefined/);
  assert.throws(() => sql`a IN (${[1, 2]})`, /sql\.list/);
  assert.throws(() => sql.list([]), /at least one/);
  assert.doesNotThrow(() => sql`a = ${null}`);
});

test('a plain string is a statement as written', () => {
  assert.deepEqual(compile('SELECT 1', 'postgres'), { text: 'SELECT 1', values: [] });
});

test('where builds equality, NULL and IN, and an empty list matches nothing', () => {
  const q = sql`SELECT 1 ${where({ a: 1, b: null, c: [2, 3], d: [] })}`;
  assert.deepEqual(compile(q, 'mysql'), { text: 'SELECT 1 WHERE `a` = ? AND `b` IS NULL AND `c` IN (?, ?) AND 1 = 0', values: [1, 2, 3] });
  assert.equal(compile(sql`SELECT 1 ${where({})}`, 'mysql').text, 'SELECT 1');
  assert.equal(compile(conditions({ a: 1 }), 'postgres').text, '"a" = $1');
});

test('insert one row, many rows, and returning', () => {
  assert.deepEqual(compile(insert('users', { name: 'a', age: 3 }), 'postgres'), {
    text: 'INSERT INTO "users" ("name", "age") VALUES ($1, $2)',
    values: ['a', 3],
  });
  assert.deepEqual(compile(insert('users', [{ name: 'a' }, { name: 'b' }]), 'mysql'), {
    text: 'INSERT INTO `users` (`name`) VALUES (?), (?)',
    values: ['a', 'b'],
  });
  assert.equal(compile(insert('users', { name: 'a' }, { returning: 'id' }), 'sqlite').text, 'INSERT INTO "users" ("name") VALUES (?) RETURNING "id"');
  assert.throws(() => insert('users', [{ a: 1 }, { b: 2 }]), /same columns/);
  assert.throws(() => insert('users', []), /no rows/);
  assert.throws(() => insert('users', {}), /no columns/);
  assert.throws(() => insert('users', { a: undefined }), /undefined/);
});

test('update and delete need a where', () => {
  assert.deepEqual(compile(update('users', { name: 'z', age: 4 }, { id: 9 }), 'postgres'), {
    text: 'UPDATE "users" SET "name" = $1, "age" = $2 WHERE "id" = $3',
    values: ['z', 4, 9],
  });
  assert.deepEqual(compile(deleteFrom('users', { id: 9 }), 'mysql'), { text: 'DELETE FROM `users` WHERE `id` = ?', values: [9] });
  assert.throws(() => update('users', { a: 1 }, {}), /needs a where/);
  assert.throws(() => deleteFrom('users', {}), /needs a where/);
  assert.equal(compile(update('users', { a: 1 }, sql`created < ${7}`), 'sqlite').text, 'UPDATE "users" SET "a" = ? WHERE created < ?');
});
