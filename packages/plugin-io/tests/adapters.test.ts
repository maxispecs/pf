import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearIoAdapters, ioAdapter, ioAdapterOrigin, ioAdapters, registerIoAdapters, validateIoAdapter, type IoContext } from '@pulpfixer/kit/io';
import { ioCommand, ioPlugin } from '../src/index.js';
import { memoryAdapter } from '../src/adapters/memory.js';
import { stdoutAdapter, stdoutSink } from '../src/adapters/stdout.js';
import { capture, ctx, freshAdapters, rows } from './helpers.js';

const io = (over: Partial<IoContext> = {}): IoContext => ({ ctx: ctx(), dryRun: false, log: () => undefined, batchSize: 2, ...over });

test('the plugin carries the memory and stdout adapters, which are valid', () => {
  assert.equal(ioPlugin.api, 3);
  assert.deepEqual(ioPlugin.ioAdapters!.map((a) => a.id), ['memory', 'stdout']);
  for (const a of ioPlugin.ioAdapters!) assert.equal(validateIoAdapter(a), null);
  assert.equal(memoryAdapter.harmless, true);
  assert.equal(stdoutAdapter.harmless, true);
});

test('memory reads in batches of the run and writes only when the pipe worked', async () => {
  const source = await memoryAdapter.source!({ rows: rows(5) }, io());
  const sizes: number[] = [];
  for await (const b of source.batches()) sizes.push(b.length);
  assert.deepEqual(sizes, [2, 2, 1]);

  const target: unknown[] = [];
  const ok = await memoryAdapter.sink!({ rows: target as never }, io());
  await ok.write(rows(2));
  assert.equal(target.length, 0);
  await ok.close(true);
  assert.equal(target.length, 2);
  const bad = await memoryAdapter.sink!({ rows: target as never }, io());
  await bad.write(rows(2));
  await bad.close(false);
  assert.equal(target.length, 2);
  await assert.rejects(memoryAdapter.source!({} as never, io()), /rows array/);
});

test('stdout prints ndjson, csv and a table, bigints as text', async () => {
  const run = async (format: 'ndjson' | 'csv' | 'table', dryRun = false) => {
    const logs: string[] = [];
    const r = await capture(async () => {
      const sink = await stdoutAdapter.sink!({ format }, io({ dryRun, log: (l) => logs.push(l) }));
      await sink.write([{ a: 1, b: 10n }, { a: 2, b: 'x,y' }]);
      await sink.write([{ a: 3, b: null }]);
      await sink.close(true);
      return 0;
    });
    return { ...r, logs };
  };
  assert.equal((await run('ndjson')).stdout, '{"a":1,"b":"10"}\n{"a":2,"b":"x,y"}\n{"a":3,"b":null}\n');
  assert.equal((await run('csv')).stdout, 'a,b\n1,10\n2,"x,y"\n3,\n');
  const table = (await run('table')).stdout;
  assert.match(table, /│ a │ b\s+│/);
  assert.match(table, /x,y/);
  const dry = await run('ndjson', true);
  assert.equal(dry.stdout, '');
  assert.deepEqual(dry.logs, ['would print 3 rows as ndjson']);
});

test('stdout prints no table for a failed run, and refuses an unknown format', async () => {
  const r = await capture(async () => {
    const sink = await stdoutAdapter.sink!({ format: 'table' }, io());
    await sink.write([{ a: 1 }]);
    await sink.close(false);
    return 0;
  });
  assert.equal(r.stdout, '');
  assert.throws(() => stdoutAdapter.describe({ format: 'xml' as never }), /format must be one of/);
  await assert.rejects(stdoutAdapter.sink!({ format: 'xml' as never }, io()), /format must be one of/);
  assert.equal(stdoutAdapter.describe({}), 'standard output (ndjson)');
  assert.deepEqual(stdoutSink('csv'), { adapter: 'stdout', config: { format: 'csv' } });
});

test('pf io adapters lists what is registered, with what each can do and where it came from', async () => {
  freshAdapters();
  registerIoAdapters([{ id: 'extra', label: 'Extra', describe: () => 'extra', source: async () => ({ batches: () => (async function* () {})(), close: async () => undefined }) }], 'plugin io-extra');
  const text = await capture(() => ioCommand.run(ctx(), []));
  assert.equal(text.code, 0);
  assert.match(text.stdout, /│ memory\s+│ Rows in memory \(tests\)\s+│ yes\s+│ yes\s+│ built in/);
  assert.match(text.stdout, /│ extra\s+│ Extra\s+│ yes\s+│ -\s+│ plugin io-extra/);
  assert.match(text.stderr, /pf plugin install io-<name>/);
  const json = await capture(() => ioCommand.run(ctx(), ['adapters', '--json']));
  const list = JSON.parse(json.stdout) as { id: string; read: boolean; write: boolean; origin: string }[];
  assert.deepEqual(list.map((a) => [a.id, a.read, a.write, a.origin]), [
    ['extra', true, false, 'plugin io-extra'],
    ['memory', true, true, 'built in'],
    ['stdout', false, true, 'built in'],
  ]);
  assert.equal((await capture(() => ioCommand.run(ctx(), ['bogus']))).code, 2);
  assert.equal((await capture(() => ioCommand.run(ctx(), ['adapters', 'stray']))).code, 2);
  assert.equal(ioAdapter('extra')?.id, 'extra');
  assert.equal(ioAdapterOrigin('memory'), 'built in');
  clearIoAdapters();
  const empty = await capture(() => ioCommand.run(ctx(), []));
  assert.match(empty.stdout, /No IO adapters/);
  assert.equal(ioAdapters().length, 0);
});

test('the menu entry counts the adapters', () => {
  freshAdapters();
  assert.equal(ioPlugin.entries!(ctx())[0]!.detail, '2 adapters');
});
