import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { validateIoAdapter, type IoContext, type Row } from '@pulpfixer/kit/io';
import { CsvError, csvAdapter, csvSink, csvSource, readFirstRecord, type CsvSinkConfig, type CsvSourceConfig } from '../src/adapter.js';
import { csvPlugin } from '../src/index.js';
import { csvCommand } from '../src/commands/csv.js';

const ctx = buildContext(os.tmpdir());
const io = (over: Partial<IoContext> = {}): IoContext => ({ ctx, dryRun: false, log: () => undefined, batchSize: 2, ...over });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-csv-'));
const write = (d: string, name: string, text: string): string => {
  const p = path.join(d, name);
  fs.writeFileSync(p, text);
  return p;
};
const read = (p: string): string => fs.readFileSync(p, 'utf8');
const leftovers = (d: string): string[] => fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));

async function readAll(config: CsvSourceConfig, over: Partial<IoContext> = {}): Promise<{ rows: Row[]; sizes: number[] }> {
  const source = await csvAdapter.source!(config, io(over));
  const rows: Row[] = [];
  const sizes: number[] = [];
  try {
    for await (const b of source.batches()) {
      sizes.push(b.length);
      rows.push(...b);
    }
  } finally {
    await source.close();
  }
  return { rows, sizes };
}

async function writeAll(config: CsvSinkConfig, batches: Row[][], ok = true, over: Partial<IoContext> = {}): Promise<void> {
  const sink = await csvAdapter.sink!(config, io(over));
  for (const b of batches) await sink.write(b);
  await sink.close(ok);
}

// capture process.stdout
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // The test runner reports through stdout with binary chunks; only the text written here is kept.
  process.stdout.write = ((s: string | Uint8Array) => (typeof s === 'string' ? chunks.push(s) : original(s), true)) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('the plugin carries a valid csv adapter and the builders fill in the mode', () => {
  assert.deepEqual(csvPlugin.ioAdapters!.map((a) => a.id), ['csv']);
  assert.equal(validateIoAdapter(csvAdapter), null);
  assert.equal(csvPlugin.api, 3);
  assert.deepEqual(csvSource({ path: 'a.csv' }), { adapter: 'csv', config: { path: 'a.csv' } });
  assert.deepEqual(csvSink({ path: 'a.csv' }), { adapter: 'csv', config: { mode: 'create', path: 'a.csv' } });
  assert.deepEqual(csvSink({ path: 'a.csv', mode: 'append' }).config.mode, 'append');
  assert.equal(csvAdapter.describe({ path: 'out.csv', mode: 'overwrite' } as never), 'csv file out.csv (overwrite)');
  assert.equal(csvAdapter.describe({ path: 'in.csv' }), 'csv file in.csv');
  assert.equal(csvAdapter.describe({ path: '-' }), 'csv on standard input/output');
});

test('a source reads a header, quoted values and cuts the rows into batches; values stay strings', async () => {
  const d = dir();
  const p = write(d, 'in.csv', '\uFEFFid,name,note\r\n1,Ann,"hello, ""world"""\r\n2,Bob,\r\n3,Cy,"two\nlines"\r\n');
  const { rows, sizes } = await readAll({ path: p });
  assert.deepEqual(rows, [
    { id: '1', name: 'Ann', note: 'hello, "world"' },
    { id: '2', name: 'Bob', note: '' },
    { id: '3', name: 'Cy', note: 'two\nlines' },
  ]);
  assert.deepEqual(sizes, [2, 1]);
});

test('a source takes a delimiter, no header, and column names', async () => {
  const d = dir();
  const p = write(d, 'in.tsv', '1\tAnn\n2\tBob\n');
  assert.deepEqual((await readAll({ path: p, delimiter: '\t', header: false, columns: ['id', 'name'] })).rows, [{ id: '1', name: 'Ann' }, { id: '2', name: 'Bob' }]);
  assert.deepEqual((await readAll({ path: p, delimiter: '\t', header: false })).rows[0], { column1: '1', column2: 'Ann' });
  const h = write(d, 'h.csv', 'A,B\n1,2\n');
  assert.deepEqual((await readAll({ path: h, columns: ['x', 'y'] })).rows, [{ x: '1', y: '2' }]);
  await assert.rejects(readAll({ path: h, columns: ['x'] }), /header of .* has 2 columns, columns lists 1/);
});

test('a source with only a header, or an empty file, has no rows', async () => {
  const d = dir();
  assert.deepEqual((await readAll({ path: write(d, 'a.csv', 'id,name\n') })).rows, []);
  assert.deepEqual((await readAll({ path: write(d, 'b.csv', '') })).rows, []);
});

test('a source says what is wrong with the file', async () => {
  const d = dir();
  await assert.rejects(csvAdapter.source!({ path: path.join(d, 'nope.csv') }, io()), /does not exist/);
  await assert.rejects(csvAdapter.source!({ path: d }, io()), /not a file/);
  await assert.rejects(readAll({ path: write(d, 'short.csv', 'a,b\n1,2\n3\n') }), /record 3 has 1 value, expected 2/);
  await assert.rejects(readAll({ path: write(d, 'dup.csv', 'a,a\n1,2\n') }), /"a" is in the header twice/);
  await assert.rejects(readAll({ path: write(d, 'noname.csv', 'a,\n1,2\n') }), /column 2 of the header has no name/);
  await assert.rejects(readAll({ path: write(d, 'open.csv', 'a\n"1\n') }), /quote is not closed/);
  await assert.rejects(csvAdapter.source!(null as never, io()), /configuration object/);
  await assert.rejects(csvAdapter.source!({ path: '' }, io()), /needs a path/);
  await assert.rejects(csvAdapter.source!({ path: 'x', delimiter: '""' }, io()), /one character/);
  await assert.rejects(csvAdapter.source!({ path: 'x', columns: ['a', 'a'] }, io()), /twice/);
  await assert.rejects(csvAdapter.source!({ path: 'x', columns: [] }, io()), /list of column names/);
  await assert.rejects(csvAdapter.source!({ path: 'x', header: 'yes' as never }, io()), /true or false/);
});

test('a source can be read once and stopping early leaves nothing open', async () => {
  const d = dir();
  const p = write(d, 'in.csv', 'n\n' + Array.from({ length: 50 }, (_, i) => i).join('\n') + '\n');
  const source = await csvAdapter.source!({ path: p }, io({ batchSize: 5 }));
  for await (const b of source.batches()) {
    assert.equal(b.length, 5);
    break;
  }
  await source.close();
  await assert.rejects((source.batches() as AsyncGenerator<Row[]>).next(), /read once/);
});

test('"-" reads standard input', async () => {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: Readable.from(['id,name\n1,a\n', '2,b\n']), configurable: true });
  try {
    assert.deepEqual((await readAll({ path: '-' })).rows, [{ id: '1', name: 'a' }, { id: '2', name: 'b' }]);
  } finally {
    Object.defineProperty(process, 'stdin', stdin);
  }
});

test('a sink writes the file only when the pipe worked, through a temporary file', async () => {
  const d = dir();
  const p = path.join(d, 'out.csv');
  const sink = await csvAdapter.sink!({ path: p }, io());
  await sink.write([{ id: 1, name: 'Ann' }, { id: 2, name: 'x,"y"' }]);
  assert.equal(fs.existsSync(p), false);
  assert.equal(leftovers(d).length, 1, 'the work is in a temporary file next to the target');
  await sink.write([{ id: 3, name: null }]);
  await sink.close(true);
  assert.equal(read(p), 'id,name\n1,Ann\n2,"x,""y"""\n3,\n');
  assert.deepEqual(leftovers(d), []);
});

test('a failed pipe leaves nothing behind (create) and the old file untouched (overwrite)', async () => {
  const d = dir();
  const p = path.join(d, 'out.csv');
  await writeAll({ path: p }, [[{ a: 1 }]], false);
  assert.equal(fs.existsSync(p), false);
  assert.deepEqual(leftovers(d), []);
  write(d, 'out.csv', 'old\n');
  await writeAll({ path: p, mode: 'overwrite' }, [[{ a: 1 }]], false);
  assert.equal(read(p), 'old\n');
  assert.deepEqual(leftovers(d), []);
});

test('create refuses an existing file, at open and when it appears while the pipe runs', async () => {
  const d = dir();
  const p = write(d, 'out.csv', 'keep\n');
  await assert.rejects(csvAdapter.sink!({ path: p }, io()), /already exists: mode "create" never replaces/);
  await assert.rejects(csvAdapter.sink!({ path: p, mode: 'create' }, io({ dryRun: true })), /already exists/);
  fs.rmSync(p);
  const sink = await csvAdapter.sink!({ path: p }, io());
  await sink.write([{ a: 1 }]);
  fs.writeFileSync(p, 'someone else\n');
  await assert.rejects(sink.close(true), /appeared while the pipe ran/);
  assert.equal(read(p), 'someone else\n');
  assert.deepEqual(leftovers(d), []);
});

test('overwrite replaces the file, keeping its permissions', async () => {
  const d = dir();
  const p = write(d, 'out.csv', 'old\n');
  fs.chmodSync(p, 0o640);
  await writeAll({ path: p, mode: 'overwrite' }, [[{ a: 1 }]]);
  assert.equal(read(p), 'a\n1\n');
  assert.equal(fs.statSync(p).mode & 0o777, 0o640);
});

test('append adds rows under the existing header, without a second header', async () => {
  const d = dir();
  const p = write(d, 'out.csv', 'id,name\n1,Ann');
  await writeAll({ path: p, mode: 'append' }, [[{ name: 'Bob', id: 2 }], [{ id: 3, name: 'Cy' }]]);
  assert.equal(read(p), 'id,name\n1,Ann\n2,Bob\n3,Cy\n');
  assert.deepEqual(leftovers(d), []);
  // a failed pipe appends nothing
  await writeAll({ path: p, mode: 'append' }, [[{ id: 4, name: 'Di' }]], false);
  assert.equal(read(p), 'id,name\n1,Ann\n2,Bob\n3,Cy\n');
  // rows with a column the file does not have are refused
  const sink = await csvAdapter.sink!({ path: p, mode: 'append' }, io());
  await assert.rejects(sink.write([{ id: 5, extra: 1 }]), /column "extra".*not in the header/);
  await sink.close(false);
  // columns that disagree with the file's header are refused
  await assert.rejects(csvAdapter.sink!({ path: p, mode: 'append', columns: ['name', 'id'] }, io()), /has the columns id, name/);
});

test('append to a missing or empty file writes a header like create', async () => {
  const d = dir();
  const p = path.join(d, 'new.csv');
  await writeAll({ path: p, mode: 'append' }, [[{ a: 1 }]]);
  assert.equal(read(p), 'a\n1\n');
  const empty = write(d, 'empty.csv', '');
  await writeAll({ path: empty, mode: 'append' }, [[{ a: 1 }]]);
  assert.equal(read(empty), 'a\n1\n');
});

test('columns fix the header and the order; a row may lack some, but may not add one', async () => {
  const d = dir();
  const p = path.join(d, 'out.csv');
  await writeAll({ path: p, columns: ['b', 'a', 'c'] }, [[{ a: 1, b: 2 }]]);
  assert.equal(read(p), 'b,a,c\n2,1,\n');
  const sink = await csvAdapter.sink!({ path: path.join(d, 'two.csv') }, io());
  await sink.write([{ a: 1 }]);
  await assert.rejects(sink.write([{ a: 1, b: 2 }]), /column "b".*list every column in columns/);
  await sink.close(false);
});

test('header false, a delimiter, and a header-only file when columns are given and there are no rows', async () => {
  const d = dir();
  const p = path.join(d, 'a.tsv');
  await writeAll({ path: p, delimiter: '\t', header: false }, [[{ a: 'x\ty', b: 2 }]]);
  assert.equal(read(p), '"x\ty"\t2\n');
  const h = path.join(d, 'h.csv');
  await writeAll({ path: h, columns: ['id', 'name'] }, []);
  assert.equal(read(h), 'id,name\n');
  const none = path.join(d, 'none.csv');
  await writeAll({ path: none }, []);
  assert.equal(read(none), '');
});

test('what a sink writes, a source reads back', async () => {
  const d = dir();
  const p = path.join(d, 'round.csv');
  const rows = [{ a: 'x,y', b: 'q"r', c: 'l1\nl2', d: '', e: '  padded  ', f: 'üñí' }, { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' }];
  await writeAll({ path: p }, [rows]);
  assert.deepEqual((await readAll({ path: p })).rows, rows);
});

test('a sink says what is wrong before it writes anything', async () => {
  const d = dir();
  await assert.rejects(csvAdapter.sink!({ path: path.join(d, 'missing-folder', 'x.csv') }, io()), /folder .* does not exist/);
  await assert.rejects(csvAdapter.sink!({ path: d, mode: 'overwrite' }, io()), /not a file/);
  await assert.rejects(csvAdapter.sink!({ path: path.join(d, 'x.csv'), mode: 'sideways' as never }, io()), /mode must be one of create, overwrite, append/);
  assert.deepEqual(fs.readdirSync(d), []);
});

test('a dry run touches no file and says what it would do', async () => {
  const d = dir();
  const logs: string[] = [];
  const p = path.join(d, 'out.csv');
  await writeAll({ path: p }, [[{ a: 1 }, { a: 2 }]], true, { dryRun: true, log: (l) => logs.push(l) });
  assert.deepEqual(fs.readdirSync(d), []);
  write(d, 'out.csv', 'a\n9\n');
  await writeAll({ path: p, mode: 'overwrite' }, [[{ a: 1 }]], true, { dryRun: true, log: (l) => logs.push(l) });
  await writeAll({ path: p, mode: 'append' }, [[{ a: 1 }, { a: 2 }, { a: 3 }]], true, { dryRun: true, log: (l) => logs.push(l) });
  assert.equal(read(p), 'a\n9\n');
  assert.deepEqual(logs, [`would write 2 rows to ${p}`, `would replace ${p} with 1 row`, `would append 3 rows to ${p}`]);
  const sink = await csvAdapter.sink!({ path: p, mode: 'append' }, io({ dryRun: true }));
  await assert.rejects(sink.write([{ zzz: 1 }]), /not in the header/);
});

test('"-" writes CSV on standard output', async () => {
  const text = await captureStdout(async () => {
    const sink = await csvAdapter.sink!({ path: '-' }, io());
    await sink.write([{ a: 1, b: 'x,y' }]);
    await sink.write([{ a: 2, b: null }]);
    await sink.close(true);
  });
  assert.equal(text, 'a,b\n1,"x,y"\n2,\n');
  const logs: string[] = [];
  const dry = await captureStdout(async () => {
    const sink = await csvAdapter.sink!({ path: '-' }, io({ dryRun: true, log: (l) => logs.push(l) }));
    await sink.write([{ a: 1 }]);
    await sink.close(true);
  });
  assert.equal(dry, '');
  assert.deepEqual(logs, ['would print 1 rows as CSV']);
  const onlyHeader = await captureStdout(async () => {
    const sink = await csvAdapter.sink!({ path: '-', columns: ['a'] }, io());
    await sink.close(true);
  });
  assert.equal(onlyHeader, 'a\n');
});

test('readFirstRecord reads the header of a big or quoted file', async () => {
  const d = dir();
  assert.deepEqual(await readFirstRecord(write(d, 'a.csv', '"a,b",c\n1,2\n')), ['a,b', 'c']);
  assert.equal(await readFirstRecord(write(d, 'e.csv', '')), null);
  assert.deepEqual(await readFirstRecord(write(d, 'long.csv', `${'x'.repeat(100_000)},y`)), ['x'.repeat(100_000), 'y']);
});

test('a big file goes through in batches without trouble', async () => {
  const d = dir();
  const src = path.join(d, 'big.csv');
  const dst = path.join(d, 'copy.csv');
  const n = 20_000;
  fs.writeFileSync(src, 'id,v\n' + Array.from({ length: n }, (_, i) => `${i},v${i}`).join('\n') + '\n');
  const source = await csvAdapter.source!({ path: src }, io({ batchSize: 1000 }));
  const sink = await csvAdapter.sink!({ path: dst }, io());
  let count = 0;
  for await (const b of source.batches()) {
    await sink.write(b);
    count += b.length;
  }
  await sink.close(true);
  await source.close();
  assert.equal(count, n);
  assert.equal(read(dst), read(src));
});

// pf csv ---------------------------------------------------------------------------------------------

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => (typeof s === 'string' ? out.push(s) : so(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (typeof s === 'string' ? err.push(s) : se(s), true)) as typeof process.stderr.write;
  try {
    const code = await csvCommand.run(ctx, args);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test('pf csv show prints a table, with a limit, JSON, a delimiter and no header', async () => {
  const d = dir();
  const p = write(d, 'in.csv', 'id,name\n' + Array.from({ length: 30 }, (_, i) => `${i + 1},n${i + 1}`).join('\n') + '\n');
  const all = await run('show', p);
  assert.equal(all.code, 0);
  assert.match(all.stdout, /│ id\s+│ name\s+│/);
  assert.match(all.stdout, /n20\b/);
  assert.doesNotMatch(all.stdout, /n21\b/);
  assert.match(all.stderr, /first 20 rows/);
  const few = await run('show', p, '--limit', '2', '--json');
  assert.deepEqual(JSON.parse(few.stdout), [{ id: '1', name: 'n1' }, { id: '2', name: 'n2' }]);
  const tsv = write(d, 'in.tsv', 'a\tb\n1\t2\n');
  assert.deepEqual(JSON.parse((await run('show', tsv, '--delimiter', 'tab', '--json')).stdout), [{ a: '1', b: '2' }]);
  assert.deepEqual(JSON.parse((await run('show', tsv, '--delimiter', 'tab', '--no-header', '--json')).stdout), [{ column1: 'a', column2: 'b' }, { column1: '1', column2: '2' }]);
  const empty = await run('show', write(d, 'empty.csv', 'id\n'));
  assert.match(empty.stdout, /\(no rows\)/);
  assert.doesNotMatch(all.stderr, /no rows/);
});

test('pf csv columns lists the column names', async () => {
  const d = dir();
  const p = write(d, 'in.csv', 'id,name,"a,b"\n1,2,3\n');
  assert.equal((await run('columns', p)).stdout, 'id\nname\na,b\n');
  assert.deepEqual(JSON.parse((await run('columns', p, '--json')).stdout), ['id', 'name', 'a,b']);
});

test('pf csv usage mistakes and file problems', async () => {
  const d = dir();
  assert.equal((await run()).code, 0);
  assert.match((await run()).stdout, /pf csv show/);
  assert.equal((await run('bogus')).code, 2);
  assert.equal((await run('show')).code, 2);
  assert.equal((await run('show', 'a', 'b')).code, 2);
  assert.equal((await run('show', 'a', '--limit', '0')).code, 2);
  const missing = await run('show', path.join(d, 'nope.csv'));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /does not exist/);
  const bad = await run('show', write(d, 'bad.csv', 'a,b\n1\n'));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /record 2 has 1 value/);
  assert.ok(new CsvError('x') instanceof Error);
});
