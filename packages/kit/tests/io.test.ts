import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearIoAdapters, ioAdapter, ioAdapterOrigin, ioAdapters, ioRef, registerIoAdapters, validateIoAdapter, type IoAdapter } from '../src/io.js';

const adapter = (id: string): IoAdapter => ({
  id,
  label: id,
  describe: () => id,
  source: async () => ({ batches: async function* () {}, close: async () => undefined }),
});

test('adapters registered through one copy of the kit are seen by another', async () => {
  clearIoAdapters();
  const second: string = '../src/io.js?second-copy';
  const other = (await import(second)) as typeof import('../src/io.js');
  assert.notEqual(other.registerIoAdapters, registerIoAdapters);
  registerIoAdapters([adapter('b'), adapter('a')]);
  assert.deepEqual(other.ioAdapters().map((a) => a.id), ['a', 'b']);
  other.registerIoAdapters([adapter('c')]);
  assert.deepEqual(ioAdapters().map((a) => a.id), ['a', 'b', 'c']);
  assert.equal(ioAdapter('c')?.id, 'c');
  clearIoAdapters();
  assert.deepEqual(other.ioAdapters(), []);
});

test('an adapter with the same id replaces the earlier one', () => {
  clearIoAdapters();
  registerIoAdapters([{ ...adapter('x'), label: 'old' }]);
  registerIoAdapters([{ ...adapter('x'), label: 'new' }]);
  assert.equal(ioAdapters().length, 1);
  assert.equal(ioAdapter('x')?.label, 'new');
  clearIoAdapters();
});

test('validateIoAdapter explains what is wrong', () => {
  assert.equal(validateIoAdapter(adapter('ok')), null);
  assert.equal(validateIoAdapter({ ...adapter('ok'), source: undefined, sink: async () => ({ write: async () => undefined, close: async () => undefined }) }), null);
  assert.match(validateIoAdapter(null)!, /object/);
  assert.match(validateIoAdapter({ ...adapter('Bad Id') })!, /lowercase id/);
  assert.match(validateIoAdapter({ ...adapter('a'), label: '' })!, /label/);
  assert.match(validateIoAdapter({ ...adapter('a'), describe: undefined })!, /describe/);
  assert.match(validateIoAdapter({ ...adapter('a'), source: undefined })!, /source\(\) or sink\(\)/);
  assert.match(validateIoAdapter({ ...adapter('a'), sink: 'x' })!, /sink/);
});

test('ioRef builds a reference', () => {
  assert.deepEqual(ioRef('csv', { path: 'a.csv' }), { adapter: 'csv', config: { path: 'a.csv' } });
});

test('the registry remembers where an adapter came from', () => {
  clearIoAdapters();
  registerIoAdapters([adapter('a')], 'built in');
  registerIoAdapters([adapter('b')]);
  assert.equal(ioAdapterOrigin('a'), 'built in');
  assert.equal(ioAdapterOrigin('b'), 'unknown');
  assert.equal(ioAdapterOrigin('zzz'), undefined);
  clearIoAdapters();
});
