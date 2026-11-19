import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearDbDrivers,
  dbDriver,
  dbDrivers,
  findForm,
  makeSession,
  registerDbDrivers,
  validateDbDriver,
  type CompiledQuery,
  type DbDriver,
} from '../src/db.js';

const driver = (id: string): DbDriver => ({
  id,
  label: id,
  dialect: 'sqlite',
  forms: [{ id: 'file', label: 'File', fields: [{ key: 'path', label: 'File', kind: 'path' }] }],
  describe: () => id,
  connect: async () => makeSession(async () => ({ rows: [] }), async () => undefined),
});

test('drivers registered through one copy of the kit are seen by another', async () => {
  clearDbDrivers();
  // A query string makes node load the file again: a second copy, like a plugin's own node_modules.
  const second: string = '../src/db.js?second-copy';
  const other = (await import(second)) as typeof import('../src/db.js');
  assert.notEqual(other.registerDbDrivers, registerDbDrivers);
  registerDbDrivers([driver('b'), driver('a')]);
  assert.deepEqual(other.dbDrivers().map((d) => d.id), ['a', 'b']);
  other.registerDbDrivers([driver('c')]);
  assert.deepEqual(dbDrivers().map((d) => d.id), ['a', 'b', 'c']);
  assert.equal(dbDriver('c')?.id, 'c');
  clearDbDrivers();
  assert.deepEqual(other.dbDrivers(), []);
});

test('a driver with the same id replaces the earlier one', () => {
  clearDbDrivers();
  registerDbDrivers([{ ...driver('x'), label: 'old' }]);
  registerDbDrivers([{ ...driver('x'), label: 'new' }]);
  assert.equal(dbDrivers().length, 1);
  assert.equal(dbDriver('x')!.label, 'new');
  clearDbDrivers();
});

test('validateDbDriver explains what is wrong', () => {
  assert.equal(validateDbDriver(driver('ok')), null);
  assert.match(validateDbDriver(null)!, /must be an object/);
  assert.match(validateDbDriver({ ...driver('x'), id: 'Bad Id' })!, /lowercase id/);
  assert.match(validateDbDriver({ ...driver('x'), dialect: 'oracle' })!, /dialect/);
  assert.match(validateDbDriver({ ...driver('x'), connect: undefined })!, /connect\(\)/);
  assert.match(validateDbDriver({ ...driver('x'), forms: [] })!, /no connection forms/);
  assert.match(validateDbDriver({ ...driver('x'), forms: [{ id: 'f', label: 'F', fields: [{ key: 'k', label: 'K', kind: 'blob' }] }] })!, /malformed field/);
});

test('findForm returns the first form by default', () => {
  const d = driver('x');
  assert.equal(findForm(d)!.id, 'file');
  assert.equal(findForm(d, 'file')!.id, 'file');
  assert.equal(findForm(d, 'nope'), undefined);
});

test('makeSession builds transactions and nested savepoints from statements', async () => {
  const log: string[] = [];
  const s = makeSession(async (q: CompiledQuery) => (log.push(q.text), { rows: [] }), async () => undefined);
  await s.transaction(async (tx) => {
    await tx.execute({ text: 'A', values: [] });
    await tx.transaction(async (t2) => {
      await t2.execute({ text: 'B', values: [] });
      await assert.rejects(t2.transaction(async () => { throw new Error('inner'); }), /inner/);
    });
  });
  assert.deepEqual(log, ['BEGIN', 'A', 'SAVEPOINT pf_sp_1', 'B', 'SAVEPOINT pf_sp_2', 'ROLLBACK TO SAVEPOINT pf_sp_2', 'RELEASE SAVEPOINT pf_sp_1', 'COMMIT']);
  // Depth is back to zero: the next one is a plain transaction.
  log.length = 0;
  await s.transaction(async () => undefined);
  assert.deepEqual(log, ['BEGIN', 'COMMIT']);
});
