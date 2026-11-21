import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateIoAdapter, type IoContext, type Row } from '@pulpfixer/kit/io';
import { connect } from '../src/client.js';
import { dbAdapter, dbSink, dbSource, insertChunks, MAX_INSERT_VALUES } from '../src/io.js';
import { dbPlugin } from '../src/index.js';
import { sql } from '../src/sql.js';
import { putConnection } from '../src/store.js';
import { ctx, freshHome, installFake } from './helpers.js';

const io = (over: Partial<IoContext> = {}): IoContext => ({ ctx: ctx(), dryRun: false, log: () => undefined, batchSize: 2, ...over });
const table = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

function setup(dialect: 'postgres' | 'mysql' = 'postgres') {
  freshHome();
  const d = installFake('fakedb', dialect);
  putConnection('main', { driver: 'fakedb', form: 'params', params: { host: 'h' }, secrets: {} });
  return d;
}

test('the db plugin carries a valid adapter that reads and writes', () => {
  assert.deepEqual(dbPlugin.ioAdapters?.map((a) => a.id), ['db']);
  assert.equal(validateIoAdapter(dbAdapter), null);
  assert.ok(dbAdapter.source && dbAdapter.sink);
  assert.equal(dbAdapter.harmless, undefined);
});

test('describe says which connection, never more', () => {
  assert.equal(dbAdapter.describe({ connection: 'main', query: sql`SELECT 1` }), 'database "main" (query)');
  assert.equal(dbAdapter.describe({ connection: 'main', table: 'orders' }), 'database "main", table orders');
  assert.equal(dbAdapter.describe({ connection: 'main', write: () => undefined }), 'database "main" (custom write)');
});

test('the builders make references to the db adapter', () => {
  const query = sql`SELECT 1`;
  assert.deepEqual(dbSource({ connection: 'c', query }), { adapter: 'db', config: { connection: 'c', query } });
  assert.deepEqual(dbSink({ connection: 'c', table: 't' }), { adapter: 'db', config: { connection: 'c', table: 't' } });
});

test('insertChunks groups consecutive rows with the same columns and respects the value limit', () => {
  assert.deepEqual(insertChunks([]), []);
  assert.deepEqual(insertChunks([{ a: 1 }, { a: 2 }, { b: 1 }, { a: 3 }]).map((c) => c.length), [2, 1, 1]);
  assert.deepEqual(insertChunks([{ a: 1, b: 2 }, { b: 3, a: 4 }]).map((c) => c.length), [2], 'column order does not matter');
  const wide = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, i]));
  const chunks = insertChunks(Array.from({ length: 3001 }, () => wide));
  assert.deepEqual(chunks.map((c) => c.length), [MAX_INSERT_VALUES / 10, 1]);
});

test('a source without driver streaming reads the result and cuts it into batches', async () => {
  const d = setup();
  d.respond = () => ({ rows: table(5) });
  const source = await dbAdapter.source!({ connection: 'main', query: sql`SELECT id FROM t WHERE x = ${1}` }, io());
  const sizes: number[] = [];
  for await (const b of source.batches()) sizes.push(b.length);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.deepEqual(d.log, [{ text: 'SELECT id FROM t WHERE x = $1', values: [1] }]);
  assert.equal(d.log.length, 1, 'the statement runs once');
  await source.close();
  assert.equal(d.closed, 1);
});

test('a source uses the driver stream with the batch size of the run', async () => {
  const d = setup('mysql');
  d.streaming = true;
  d.respond = () => ({ rows: table(5) });
  const source = await dbAdapter.source!({ connection: 'main', query: 'SELECT id FROM t' }, io({ batchSize: 4 }));
  const sizes: number[] = [];
  for await (const b of source.batches()) sizes.push(b.length);
  assert.deepEqual(sizes, [4, 1]);
  assert.deepEqual(d.streamSizes, [4]);
  await source.close();
});

test('a source may only read: its handle refuses writes', async () => {
  const d = setup();
  const db = await connect('main', { writes: 'deny' });
  await assert.rejects(db.exec('DELETE FROM t'), /may only read/);
  assert.equal(d.log.length, 0);
  await db.close();
});

test('a table sink inserts every batch inside one transaction and commits when the pipe worked', async () => {
  const d = setup();
  const sink = await dbAdapter.sink!({ connection: 'main', table: 'orders' }, io());
  await sink.write([{ id: 1, n: 'a' }, { id: 2, n: 'b' }]);
  await sink.write([{ id: 3, n: 'c' }]);
  await sink.write([]);
  await sink.close(true);
  assert.deepEqual(d.log.map((q) => q.text), [
    'BEGIN',
    'INSERT INTO "orders" ("id", "n") VALUES ($1, $2), ($3, $4)',
    'INSERT INTO "orders" ("id", "n") VALUES ($1, $2)',
    'COMMIT',
  ]);
  assert.deepEqual(d.log[1]!.values, [1, 'a', 2, 'b']);
  assert.equal(d.closed, 1);
});

test('a sink rolls back when the pipe failed, and nothing is committed', async () => {
  const d = setup();
  const sink = await dbAdapter.sink!({ connection: 'main', table: 'orders' }, io());
  await sink.write([{ id: 1 }]);
  await sink.close(false);
  assert.deepEqual(d.log.map((q) => q.text), ['BEGIN', 'INSERT INTO "orders" ("id") VALUES ($1)', 'ROLLBACK']);
  assert.equal(d.closed, 1);
});

test('a failing insert is thrown to the pipe, and closing with false rolls back', async () => {
  const d = setup();
  d.respond = (q) => {
    if (q.text.startsWith('INSERT')) throw new Error('duplicate key');
    return { rows: [] };
  };
  const sink = await dbAdapter.sink!({ connection: 'main', table: 'orders' }, io());
  await assert.rejects(sink.write([{ id: 1 }]), /duplicate key/);
  await sink.close(false);
  assert.deepEqual(d.log.map((q) => q.text).filter((t) => t !== 'ROLLBACK' && t !== 'BEGIN'), ['INSERT INTO "orders" ("id") VALUES ($1)']);
  assert.equal(d.log.at(-1)!.text, 'ROLLBACK');
});

test('a commit that fails is reported by close, and the connection is closed anyway', async () => {
  const d = setup();
  d.respond = (q) => {
    if (q.text === 'COMMIT') throw new Error('could not serialize');
    return { rows: [] };
  };
  const sink = await dbAdapter.sink!({ connection: 'main', table: 'orders' }, io());
  await sink.write([{ id: 1 }]);
  await assert.rejects(sink.close(true), /could not serialize/);
  assert.equal(d.closed, 1);
});

test('a write sink hands each batch to your function inside the transaction', async () => {
  const d = setup();
  const sink = await dbAdapter.sink!(
    {
      connection: 'main',
      write: async (db, rows) => {
        for (const r of rows) await db.exec(sql`UPDATE totals SET n = n + ${r.id as number} WHERE k = ${'x'}`);
      },
    },
    io(),
  );
  await sink.write(table(2));
  await sink.close(true);
  assert.deepEqual(d.log.map((q) => q.text), ['BEGIN', 'UPDATE totals SET n = n + $1 WHERE k = $2', 'UPDATE totals SET n = n + $1 WHERE k = $2', 'COMMIT']);
});

test('a dry run writes nothing: no transaction, no insert, and it says what it would do', async () => {
  const d = setup();
  const logs: string[] = [];
  const sink = await dbAdapter.sink!({ connection: 'main', table: 'orders' }, io({ dryRun: true, log: (l) => logs.push(l) }));
  await sink.write(table(3));
  await sink.close(true);
  assert.deepEqual(d.log, []);
  assert.deepEqual(logs, ['would insert 3 rows into orders']);
  assert.equal(d.closed, 1);

  const custom: string[] = [];
  const own = await dbAdapter.sink!(
    { connection: 'main', write: async (db) => void (await db.exec(sql`DELETE FROM t WHERE a = ${1}`)) },
    io({ dryRun: true, log: (l) => custom.push(l) }),
  );
  await own.write(table(1));
  await own.close(true);
  assert.deepEqual(d.log, []);
  assert.deepEqual(custom, ['would run DELETE FROM t WHERE a = $1   [1]']);
});

test('a bad configuration is explained', async () => {
  setup();
  await assert.rejects(dbAdapter.source!(null as never, io()), /configuration object/);
  await assert.rejects(dbAdapter.source!({ connection: '' } as never, io()), /connection name/);
  await assert.rejects(dbAdapter.source!({ connection: 'main' } as never, io()), /needs a query/);
  await assert.rejects(dbAdapter.sink!({ connection: 'main' } as never, io()), /table .* or a write/);
  await assert.rejects(dbAdapter.sink!({ connection: 'main', table: '' }, io()), /table name/);
});

test('a missing connection says how to add it', async () => {
  freshHome();
  await assert.rejects(
    dbAdapter.source!({ connection: 'nope', query: 'SELECT 1', driver: 'postgres' }, io()),
    (e: Error & { hint?: string }) => /no database connection "nope"|there is no database connection "nope"/.test(e.message) && e.hint === 'pf db add nope --driver postgres',
  );
});
