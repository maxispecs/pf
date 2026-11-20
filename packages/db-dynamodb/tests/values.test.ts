import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, decodeItem, decodeNumber, encode, ValueError } from '../src/values.js';

test('encode: scalars', () => {
  assert.deepEqual(encode('a'), { S: 'a' });
  assert.deepEqual(encode(5), { N: '5' });
  assert.deepEqual(encode(1.5), { N: '1.5' });
  assert.deepEqual(encode(12345678901234567890n), { N: '12345678901234567890' });
  assert.deepEqual(encode(true), { BOOL: true });
  assert.deepEqual(encode(null), { NULL: true });
  assert.deepEqual(encode(new Date('2026-01-02T03:04:05Z')), { S: '2026-01-02T03:04:05.000Z' });
  assert.deepEqual(encode(Buffer.from('hi')), { B: 'aGk=' });
});

test('encode: lists, maps and sets', () => {
  assert.deepEqual(encode([1, 'a']), { L: [{ N: '1' }, { S: 'a' }] });
  assert.deepEqual(encode({ a: { b: null } }), { M: { a: { M: { b: { NULL: true } } } } });
  assert.deepEqual(encode(new Set(['x', 'y'])), { SS: ['x', 'y'] });
  assert.deepEqual(encode(new Set([1, 2])), { NS: ['1', '2'] });
});

test('encode refuses what DynamoDB cannot hold', () => {
  assert.throws(() => encode(undefined), ValueError);
  assert.throws(() => encode(NaN), /NaN/);
  assert.throws(() => encode(Infinity), /Infinity/);
  assert.throws(() => encode(new Set()), /empty set/);
  assert.throws(() => encode(new Set([1, 'a'])), /only strings/);
  assert.throws(() => encode(() => 1), /function/);
  assert.throws(() => encode(new Date('x')), /invalid Date/);
  assert.throws(() => encode(new Map()), /plain object/);
});

test('decodeNumber keeps a number exact', () => {
  assert.equal(decodeNumber('42'), 42);
  assert.equal(decodeNumber('-7'), -7);
  assert.equal(decodeNumber('0.1'), 0.1);
  assert.equal(decodeNumber('12345678901234567890'), '12345678901234567890');
  assert.equal(decodeNumber('0.1000000000000000055511151231257827'), '0.1000000000000000055511151231257827');
  assert.equal(decodeNumber('1E+30'), '1E+30');
});

test('decode: every attribute type', () => {
  assert.equal(decode({ S: 'a' }), 'a');
  assert.equal(decode({ N: '3' }), 3);
  assert.equal(decode({ BOOL: false }), false);
  assert.equal(decode({ NULL: true }), null);
  assert.deepEqual(decode({ B: 'aGk=' }), Buffer.from('hi'));
  assert.deepEqual(decode({ L: [{ N: '1' }, { S: 'x' }] }), [1, 'x']);
  assert.deepEqual(decode({ SS: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(decode({ NS: ['1', '2.5'] }), [1, 2.5]);
  assert.deepEqual(decode({ BS: ['aGk='] }), [Buffer.from('hi')]);
  assert.deepEqual(decodeItem({ id: { S: 'x' }, n: { M: { a: { N: '1' } } } }), { id: 'x', n: { a: 1 } });
  assert.throws(() => decode({ X: 1 } as never), /unknown DynamoDB attribute/);
});

test('round trip', () => {
  const v = { a: 'x', b: 1.25, c: [true, null], d: { e: 'f' } };
  assert.deepEqual(decode(encode(v)), v);
});
