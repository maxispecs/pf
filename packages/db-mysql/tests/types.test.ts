import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reader, Writer } from '../src/packet.js';
import { stmtExecute } from '../src/protocol.js';
import { decodeBinaryRow, decodeText, encodeParam, FLAG_UNSIGNED, parseColumn, TYPE, type Column } from '../src/types.js';
import { column } from './fakeserver.js';

const col = (type: number, extra: Partial<Column> = {}): Column => ({ name: 'c', charset: 224, type, flags: 0, decimals: 0, ...extra });
const text = (type: number, s: string | null, extra: Partial<Column> = {}) => decodeText(col(type, extra), s === null ? null : Buffer.from(s));

test('column definitions', () => {
  assert.deepEqual(parseColumn(column({ name: 'total', type: TYPE.NEWDECIMAL, charset: 63, flags: FLAG_UNSIGNED, decimals: 2 })), {
    name: 'total',
    charset: 63,
    type: TYPE.NEWDECIMAL,
    flags: FLAG_UNSIGNED,
    decimals: 2,
  });
});

test('text protocol: numbers, exact decimals and big integers', () => {
  assert.equal(text(TYPE.TINY, '-5'), -5);
  assert.equal(text(TYPE.YEAR, '2026'), 2026);
  assert.equal(text(TYPE.DOUBLE, '1.5e3'), 1500);
  assert.equal(text(TYPE.NEWDECIMAL, '0.10'), '0.10');
  assert.equal(text(TYPE.LONGLONG, '9007199254740991'), 9007199254740991);
  assert.equal(text(TYPE.LONGLONG, '9007199254740992'), '9007199254740992');
  assert.equal(text(TYPE.LONGLONG, '-9223372036854775808'), '-9223372036854775808');
  assert.equal(text(TYPE.LONG, null), null);
});

test('text protocol: dates in local time, zero dates invalid, TIME as text', () => {
  const d = text(TYPE.DATETIME, '0099-02-03 04:05:06.7') as Date;
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()], [99, 1, 3, 4, 5, 6, 700]);
  const day = text(TYPE.DATE, '2026-11-19') as Date;
  assert.deepEqual([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()], [2026, 10, 19, 0]);
  assert.ok(Number.isNaN((text(TYPE.TIMESTAMP, '0000-00-00 00:00:00') as Date).getTime()));
  assert.equal(text(TYPE.TIME, '838:59:59'), '838:59:59');
});

test('text protocol: JSON, binary and text strings', () => {
  assert.deepEqual(text(TYPE.JSON, '{"a":null}'), { a: null });
  assert.deepEqual(text(TYPE.BLOB, 'xy', { charset: 63 }), Buffer.from('xy'));
  assert.deepEqual(text(TYPE.BIT, '\x01'), Buffer.from([1]));
  assert.equal(text(TYPE.BLOB, 'long text'), 'long text', 'TEXT is a BLOB with a text charset');
  assert.equal(text(TYPE.ENUM, 'red'), 'red');
});

test('binary protocol: a row with the null bitmap and every width', () => {
  const columns = [
    col(TYPE.TINY),
    col(TYPE.TINY, { flags: FLAG_UNSIGNED }),
    col(TYPE.SHORT),
    col(TYPE.LONG, { flags: FLAG_UNSIGNED }),
    col(TYPE.LONGLONG),
    col(TYPE.VAR_STRING),
    col(TYPE.DOUBLE),
    col(TYPE.DATETIME),
    col(TYPE.TIME, { decimals: 3 }),
    col(TYPE.NEWDECIMAL),
    col(TYPE.DATE),
  ].map((c, i) => ({ ...c, name: `c${i}` }));
  // c5 is NULL: bit 5 + 2 = 7 of the first bitmap byte.
  const w = new Writer().u8(0).u8(0x80).u8(0);
  w.u8(0xff).u8(0xff).u16(0xfffe).u32(0xffffffff).i64(-(2n ** 62n));
  w.f64(-0.25);
  w.u8(7).u16(2026).u8(11).u8(19).u8(23).u8(59).u8(58);
  w.u8(12).u8(1).u32(1).u8(2).u8(3).u8(4).u32(5000);
  w.lenencString('12.34');
  w.u8(0);
  const row = decodeBinaryRow(columns, w.toBuffer());
  assert.equal(row.c0, -1);
  assert.equal(row.c1, 255);
  assert.equal(row.c2, -2);
  assert.equal(row.c3, 4294967295);
  assert.equal(row.c4, '-4611686018427387904');
  assert.equal(row.c5, null);
  assert.equal(row.c6, -0.25);
  assert.equal((row.c7 as Date).getHours(), 23);
  assert.equal(row.c8, '-26:03:04.005');
  assert.equal(row.c9, '12.34');
  assert.ok(Number.isNaN((row.c10 as Date).getTime()));
});

test('parameters: each JavaScript value gets a MySQL type', () => {
  assert.deepEqual(encodeParam(null), { type: TYPE.NULL, unsigned: false, value: null });
  assert.equal(encodeParam(true).type, TYPE.TINY);
  assert.equal(new Reader(encodeParam(-7).value!).i64(), -7n);
  assert.equal(new Reader(encodeParam(0.5).value!).f64(), 0.5);
  assert.equal(encodeParam(2n ** 64n - 1n).unsigned, true);
  assert.throws(() => encodeParam(2n ** 64n), /does not fit/);
  assert.throws(() => encodeParam(Number.NaN), /cannot store NaN/);
  assert.throws(() => encodeParam(new Date(Number.NaN)), /Invalid Date/);
  assert.throws(() => encodeParam(() => 1), /cannot bind a function/);
  assert.equal(new Reader(encodeParam('ä').value!).lenencString(), 'ä');
  assert.equal(new Reader(encodeParam({ a: 1 }).value!).lenencString(), '{"a":1}');
  assert.deepEqual(new Reader(encodeParam(new Uint8Array([1, 2])).value!).lenencBytes(), Buffer.from([1, 2]));
});

test('COM_STMT_EXECUTE: the null bitmap, the bound types and the values', () => {
  const payload = stmtExecute(9, [encodeParam(1), encodeParam(null), encodeParam('x')]);
  const r = new Reader(payload);
  assert.deepEqual([r.u8(), r.u32(), r.u8(), r.u32()], [0x17, 9, 0, 1]);
  assert.equal(r.u8(), 0b010, 'the second value is NULL');
  assert.equal(r.u8(), 1);
  assert.deepEqual([r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8()], [TYPE.LONGLONG, 0, TYPE.NULL, 0, TYPE.VAR_STRING, 0]);
  assert.equal(r.i64(), 1n);
  assert.equal(r.lenencString(), 'x');
  assert.equal(r.remaining, 0);
  assert.equal(stmtExecute(9, []).length, 10, 'no values: no bitmap');
});
