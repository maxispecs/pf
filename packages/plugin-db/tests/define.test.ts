import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSession, type DbSession } from '@pulpfixer/kit/db';
import { out } from '@pulpfixer/kit/ui/palette';
import { connect, makeDb } from '../src/client.js';
import { defineQueries, parseParams, queryUsage } from '../src/define.js';
import { render, toCsv } from '../src/output.js';
import { sql } from '../src/sql.js';
import { putConnection } from '../src/store.js';
import { capture, ctx, freshHome, installFake } from './helpers.js';

process.env.NO_COLOR = '1';
const plain = out();

test('parseParams reads flags, converts types, applies defaults and checks choices', () => {
  const defs = {
    month: { required: true, help: 'YYYY-MM' },
    limit: { type: 'number' as const, default: 10 },
    all: { type: 'boolean' as const },
    kind: { choices: ['a', 'b'] },
    productId: {},
  };
  const args = ['--month', '2026-10', '--all', '--product-id=7', '--limit', '3'];
  assert.deepEqual(parseParams(defs, args), { values: { month: '2026-10', limit: 3, all: true, productId: '7' } });
  assert.deepEqual(args, []);
  assert.deepEqual(parseParams(defs, ['--month', 'x']), { values: { month: 'x', limit: 10 } });
  assert.match((parseParams(defs, []) as { error: string }).error, /--month is required \(YYYY-MM\)/);
  assert.match((parseParams(defs, ['--month', 'x', '--limit', 'ten']) as { error: string }).error, /must be a number/);
  assert.match((parseParams(defs, ['--month', 'x', '--kind', 'z']) as { error: string }).error, /one of a, b/);
  assert.match((parseParams(defs, ['--month']) as { error: string }).error, /needs a value/);
  assert.deepEqual(parseParams(defs, ['--month', 'x', '--no-all']), { values: { month: 'x', limit: 10, all: false } });
});

test('queryUsage shows required and optional flags', () => {
  const def = { summary: 's', params: { month: { required: true }, all: { type: 'boolean' as const } }, run: () => [] };
  assert.equal(queryUsage('revrec', 'monthly', def), 'pf revrec monthly --month <month> [--all]');
});

test('render: table, CSV, JSON, write results and odd values', () => {
  const rows = [
    { product: 'a', amount: '10.50', when: new Date('2026-01-02T00:00:00Z'), big: 12n },
    { product: 'b,"x"', amount: null, when: null, big: 1n },
  ];
  const t = render(rows, 'table', plain);
  assert.match(t, /product/);
  assert.match(t, /2026-01-02T00:00:00.000Z/);
  assert.equal(toCsv(rows).split('\n')[0], 'product,amount,when,big');
  assert.equal(toCsv(rows).split('\n')[2], '"b,""x""",,,1');
  assert.deepEqual(JSON.parse(render(rows, 'json', plain))[0].big, '12');
  assert.equal(render({ rows: [], affected: 3 }, 'table', plain), '3 rows affected');
  assert.equal(render([], 'table', plain), '(no rows)');
  assert.equal(render([], 'csv', plain), '');
  assert.equal(render(undefined, 'table', plain), '');
  assert.equal(render({ total: 5 }, 'table', plain), '{\n  "total": 5\n}');
});

function packageWith(def: Partial<Parameters<typeof defineQueries>[0]> = {}) {
  return defineQueries({
    name: 'revrec',
    summary: 'Revenue recognition',
    connection: 'billing',
    driver: 'fake',
    queries: {
      monthly: {
        summary: 'Revenue per product for a month',
        params: { month: { required: true } },
        run: (db, { month }) => db.all(sql`SELECT product, SUM(amount) AS total FROM revenue WHERE period = ${month} GROUP BY product`),
      },
      fix: {
        summary: 'Correct a period',
        writes: true,
        params: { id: { type: 'number', required: true } },
        run: async (db, { id }) => {
          const rows = await db.all(sql`SELECT id FROM revenue WHERE id = ${id}`);
          await db.update('revenue', { fixed: 1 }, { id });
          return { rows, affected: 0 };
        },
      },
      sneaky: { summary: 'Writes without saying so', run: (db) => db.exec(sql`DELETE FROM revenue`) },
    },
    ...def,
  });
}

const run = (plugin: ReturnType<typeof packageWith>, ...args: string[]) => capture(() => plugin.commands[0]!.run(ctx(), args));

test('a query package lists its queries and runs one with flags', async () => {
  freshHome();
  const d = installFake();
  putConnection('billing', { driver: 'fake', form: 'params', params: { host: 'h' }, secrets: {} });
  d.respond = () => ({ rows: [{ product: 'widget', total: '12.50' }] });
  const p = packageWith();

  const list = await run(p);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /pf revrec monthly --month <month>/);
  assert.match(list.stdout, /Correct a period \(changes data\)/);

  const r = await run(p, 'monthly', '--month', '2026-10', '--csv');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'product,total\nwidget,12.50\n');
  assert.deepEqual(d.log[0], { text: 'SELECT product, SUM(amount) AS total FROM revenue WHERE period = ? GROUP BY product', values: ['2026-10'] });

  const missing = await run(p, 'monthly');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--month is required/);
  assert.equal((await run(p, 'nope')).code, 2);
  assert.equal((await run(p, 'monthly', '--month', 'x', 'extra')).code, 2);
});

test('--db picks another connection; a missing one says how to add it', async () => {
  freshHome();
  const d = installFake();
  putConnection('other', { driver: 'fake', form: 'params', params: { host: 'other-host' }, secrets: {} });
  const p = packageWith();
  const r = await run(p, 'monthly', '--month', 'x', '--db', 'other');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(d.connects[0]!.params.host, 'other-host');
  const none = await run(p, 'monthly', '--month', 'x');
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no database connection "billing"/);
  assert.match(none.stderr, /pf db add billing --driver fake/);
});

test('a query that is not marked as writing cannot write', async () => {
  freshHome();
  const d = installFake();
  putConnection('billing', { driver: 'fake', form: 'params', params: { host: 'h' }, secrets: {} });
  const r = await run(packageWith(), 'sneaky');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /may only read/);
  assert.deepEqual(d.log, []);
});

test('a writing query confirms first; --yes runs it; --dry-run shows the write instead', async () => {
  freshHome();
  const d = installFake();
  putConnection('billing', { driver: 'fake', form: 'params', params: { host: 'h' }, secrets: {} });
  d.respond = () => ({ rows: [{ id: 4 }] });
  const p = packageWith();

  const asked = await run(p, 'fix', '--id', '4');
  assert.equal(asked.code, 1);
  assert.match(asked.stderr, /--yes/);
  assert.equal(d.log.length, 0);

  const dry = await run(p, 'fix', '--id', '4', '--dry-run');
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /would run UPDATE `revenue` SET `fixed` = \? WHERE `id` = \?/);
  assert.deepEqual(d.log.map((q) => q.text), ['SELECT id FROM revenue WHERE id = ?']); // the read ran, the write did not

  d.log.length = 0;
  const yes = await run(p, 'fix', '--id', '4', '--yes');
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual(d.log.map((q) => q.text), ['SELECT id FROM revenue WHERE id = ?', 'UPDATE `revenue` SET `fixed` = ? WHERE `id` = ?']);
});

test('the Db client: one, value, insert, transaction with rollback', async () => {
  freshHome();
  const d = installFake('fakepg', 'postgres');
  putConnection('pg', { driver: 'fakepg', form: 'params', params: { host: 'h' }, secrets: {} });
  const db = await connect('pg');
  d.respond = () => ({ rows: [{ n: 7, other: 1 }, { n: 8 }] });
  assert.deepEqual(await db.one(sql`SELECT n FROM t`), { n: 7, other: 1 });
  assert.equal(await db.value(sql`SELECT n FROM t`), 7);
  d.respond = () => ({ rows: [] });
  assert.equal(await db.one('SELECT 1 WHERE false'), undefined);
  assert.equal(await db.value('SELECT 1 WHERE false'), undefined);

  d.log.length = 0;
  await db.insert('t', { a: 1 });
  assert.deepEqual(d.log[0], { text: 'INSERT INTO "t" ("a") VALUES ($1)', values: [1] });

  d.log.length = 0;
  await db.transaction(async (tx) => {
    await tx.exec('UPDATE t SET a = 1');
    await tx.transaction(async (inner) => void (await inner.exec('UPDATE t SET a = 2')));
  });
  assert.deepEqual(d.log.map((q) => q.text), ['BEGIN', 'UPDATE t SET a = 1', 'SAVEPOINT pf_sp_1', 'UPDATE t SET a = 2', 'RELEASE SAVEPOINT pf_sp_1', 'COMMIT']);

  d.log.length = 0;
  await assert.rejects(db.transaction(async (tx) => {
    await tx.exec('UPDATE t SET a = 3');
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(d.log.map((q) => q.text), ['BEGIN', 'UPDATE t SET a = 3', 'ROLLBACK']);
  await db.close();
});

test('makeDb with a deny policy refuses writes and dry only reports them', async () => {
  const log: string[] = [];
  const session: DbSession = makeSession(async (q) => (log.push(q.text), { rows: [] }), async () => undefined);
  const dry: string[] = [];
  const denied = makeDb(session, 'sqlite', 'x', { writes: 'deny' });
  await assert.rejects(denied.exec('DELETE FROM t'), /may only read/);
  const dryDb = makeDb(session, 'sqlite', 'x', { writes: 'dry', onDryWrite: (q) => dry.push(q.text) });
  await dryDb.exec('DELETE FROM t');
  await dryDb.all('SELECT 1');
  assert.deepEqual(dry, ['DELETE FROM t']);
  assert.deepEqual(log, ['SELECT 1']);
});
