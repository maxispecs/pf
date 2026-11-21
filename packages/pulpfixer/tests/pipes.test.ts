import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { clearDbDrivers } from '@pulpfixer/kit/db';
import { clearIoAdapters } from '@pulpfixer/kit/io';
import { csvSink, csvSource } from '@pulpfixer/plugin-csv/api';
import { dbSink, dbSource, sql, withDb } from '@pulpfixer/plugin-db/api';
import { definePipes } from '@pulpfixer/plugin-io/api';
import { BUILTIN_PLUGINS } from '../src/plugins/index.js';
import { registerPluginContributions } from '../src/plugins/loader.js';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 13);

let home: string;
let work: string;
const ctx = buildContext(os.tmpdir());

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pipes-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pipes-work-'));
  process.env.PF_HOME = home;
  clearDbDrivers();
  clearIoAdapters();
  registerPluginContributions(BUILTIN_PLUGINS, true);
  if (!hasSqlite) return;
  fs.mkdirSync(path.join(home, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'db', 'connections.json'),
    JSON.stringify({ version: 1, connections: { shop: { driver: 'sqlite', form: 'file', params: { path: path.join(work, 'shop.db') }, secrets: {} } } }),
  );
  await withDb('shop', async (db) => {
    await db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT, cents INTEGER)');
    await db.exec('CREATE TABLE archive (id INTEGER PRIMARY KEY, name TEXT, euros REAL)');
    await db.insert('orders', Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `order, ${i + 1}`, cents: (i + 1) * 150 })));
  });
});

after(() => {
  delete process.env.PF_HOME;
  clearDbDrivers();
  clearIoAdapters();
});

const plugin = definePipes({
  name: 'shop-etl',
  summary: 'Shop data in and out',
  pipes: {
    export: {
      summary: 'Orders to a CSV file',
      params: { out: { required: true }, minCents: { type: 'number', default: 0 } },
      inputs: ({ minCents }) => ({ orders: dbSource({ connection: 'shop', query: sql`SELECT id, name, cents FROM orders WHERE cents >= ${minCents} ORDER BY id` }) }),
      outputs: ({ out }) => ({ file: csvSink({ path: out, mode: 'overwrite' }) }),
      transform: (row) => ({ id: row.id, name: row.name, euros: (row.cents as number) / 100 }),
    },
    import: {
      summary: 'A CSV file into the archive table',
      params: { file: { required: true }, failAt: { type: 'number' } },
      inputs: ({ file }) => ({ rows: csvSource({ path: file }) }),
      outputs: { archive: dbSink({ connection: 'shop', table: 'archive' }) },
      transform: (row, { failAt }) => {
        if (failAt !== undefined && row.id === String(failAt)) throw new Error(`bad row ${failAt}`);
        return { id: Number(row.id), name: row.name, euros: Number(row.euros) };
      },
    },
    both: {
      summary: 'Orders to two files at once, counted by a run()',
      params: { a: { required: true }, b: { required: true } },
      inputs: { orders: dbSource({ connection: 'shop', query: 'SELECT id, name FROM orders ORDER BY id' }) },
      outputs: ({ a, b }) => ({ first: csvSink({ path: a }), second: csvSink({ path: b }) }),
      async run({ inputs, outputs, from, log }) {
        const result = await from(inputs.orders!).filter((r) => (r.id as number) % 2 === 1).to(outputs.first!, outputs.second!);
        log(`${result.rows} odd orders`);
      },
    },
  },
});
const command = plugin.commands[0]!;

async function pf(...args: string[]): Promise<{ code: number; stderr: string }> {
  const err: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => (typeof s === 'string' ? err.push(s) : se(s), true)) as typeof process.stderr.write;
  try {
    const code = await command.run(ctx, args);
    return { code, stderr: err.join('') };
  } finally {
    process.stderr.write = se;
  }
}

const archive = () => withDb('shop', (db) => db.all('SELECT id, name, euros FROM archive ORDER BY id'));
const names = (d: string): string[] => fs.readdirSync(d).sort();

test('database to CSV to database, through the real adapters', { skip: !hasSqlite && 'needs Node 22.13+' }, async () => {
  const csv = path.join(work, 'orders.csv');
  const exported = await pf('export', '--out', csv, '--yes', '--batch-size', '3');
  assert.equal(exported.code, 0, exported.stderr);
  assert.match(exported.stderr, /reads orders: database "shop" \(query\)/);
  assert.match(exported.stderr, /writes file: csv file .*orders\.csv \(overwrite\)/);
  assert.match(exported.stderr, /read orders 7 rows/);
  assert.equal(fs.readFileSync(csv, 'utf8'), ['id,name,euros', '1,"order, 1",1.5', '2,"order, 2",3', ...Array.from({ length: 5 }, (_, i) => `${i + 3},"order, ${i + 3}",${((i + 3) * 150) / 100}`), ''].join('\n'));

  const imported = await pf('import', '--file', csv, '--yes', '--batch-size', '2');
  assert.equal(imported.code, 0, imported.stderr);
  const rows = await archive();
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1], { id: 2, name: 'order, 2', euros: 3 });
});

test('a pipe that fails half way rolls the table back and leaves no file behind', { skip: !hasSqlite && 'needs Node 22.13+' }, async () => {
  await withDb('shop', (db) => db.exec('DELETE FROM archive'));
  const csv = path.join(work, 'again.csv');
  assert.equal((await pf('export', '--out', csv, '--yes')).code, 0);
  const failed = await pf('import', '--file', csv, '--yes', '--batch-size', '2', '--fail-at', '5');
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /shop-etl import failed: bad row 5/);
  assert.match(failed.stderr, /discarded archive/);
  assert.deepEqual(await archive(), []);

  const target = path.join(work, 'keep.csv');
  fs.writeFileSync(target, 'keep\n');
  const broken = await pf('export', '--out', target, '--yes', '--min-cents', 'x');
  assert.equal(broken.code, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
  assert.deepEqual(names(work).filter((n) => n.endsWith('.tmp')), []);
});

test('without --yes and without a terminal nothing is written; a dry run reads and reports', { skip: !hasSqlite && 'needs Node 22.13+' }, async () => {
  const csv = path.join(work, 'never.csv');
  const refused = await pf('export', '--out', csv);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--yes/);
  assert.equal(fs.existsSync(csv), false);

  const dry = await pf('export', '--out', csv, '--dry-run');
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /would write 7 rows to .*never\.csv/);
  assert.equal(fs.existsSync(csv), false);

  await withDb('shop', (db) => db.exec('DELETE FROM archive'));
  const src = path.join(work, 'src.csv');
  fs.writeFileSync(src, 'id,name,euros\n1,a,1.5\n2,b,2\n');
  const dryImport = await pf('import', '--file', src, '--dry-run');
  assert.equal(dryImport.code, 0, dryImport.stderr);
  assert.match(dryImport.stderr, /would insert 2 rows into archive/);
  assert.deepEqual(await archive(), []);
});

test('a run() can send rows to several outputs, and a source filter reaches the query', { skip: !hasSqlite && 'needs Node 22.13+' }, async () => {
  const a = path.join(work, 'a.csv');
  const b = path.join(work, 'b.csv');
  const r = await pf('both', '--a', a, '--b', b, '--yes');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /4 odd orders/);
  assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
  assert.equal(fs.readFileSync(a, 'utf8').trim().split('\n').length, 5);

  const few = path.join(work, 'few.csv');
  assert.equal((await pf('export', '--out', few, '--yes', '--min-cents', '900')).code, 0);
  assert.equal(fs.readFileSync(few, 'utf8').trim().split('\n').length, 1 + 2);
});

test('a pipe naming a connection that does not exist says how to add it', { skip: !hasSqlite && 'needs Node 22.13+' }, async () => {
  const p = definePipes({ name: 'ghost', summary: 'g', pipes: { go: { summary: 'go', inputs: { x: dbSource({ connection: 'nope', query: 'SELECT 1' }) }, outputs: { y: csvSink({ path: path.join(work, 'g.csv') }) } } } });
  const err: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => (typeof s === 'string' ? err.push(s) : se(s), true)) as typeof process.stderr.write;
  let code: number;
  try {
    code = await p.commands[0]!.run(ctx, ['go', '--yes']);
  } finally {
    process.stderr.write = se;
  }
  assert.equal(code, 1);
  assert.match(err.join(''), /no database connection "nope"/);
  assert.match(err.join(''), /pf db add nope/);
});
