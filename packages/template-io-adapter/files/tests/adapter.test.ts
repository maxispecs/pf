import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { validateIoAdapter, type IoContext, type Row } from '@pulpfixer/kit/io';
import plugin, { adapter, sink, source } from '../src/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-{{name}}-test-'));
const logs: string[] = [];
const io = (over: Partial<IoContext> = {}): IoContext => ({ ctx: buildContext(dir), dryRun: false, log: (l) => void logs.push(l), batchSize: 2, ...over });

async function readAll(file: string): Promise<Row[]> {
  const src = await adapter.source!({ path: file }, io());
  const rows: Row[] = [];
  for await (const batch of src.batches()) rows.push(...batch);
  await src.close();
  return rows;
}

test('the plugin declares api 3 and a valid adapter', () => {
  assert.equal(plugin.api, 3);
  assert.equal(plugin.name, 'io-{{name}}');
  assert.equal(plugin.ioAdapters.length, 1);
  assert.equal(validateIoAdapter(adapter), null);
  assert.ok(adapter.source && adapter.sink);
  assert.deepEqual(source({ path: 'a' }), { adapter: '{{name}}', config: { path: 'a' } });
  assert.deepEqual(sink({ path: 'b' }), { adapter: '{{name}}', config: { path: 'b' } });
});

test('describe is one line and needs no secrets', () => {
  assert.equal(adapter.describe({ path: '/x/y' }), '{{name}} file /x/y');
});

test('rows written come back out, in batches', async () => {
  const file = path.join(dir, 'round.ndjson');
  const out = await adapter.sink!({ path: file }, io());
  await out.write([{ id: 1 }, { id: 2 }]);
  await out.write([{ id: 3, name: 'c' }]);
  assert.equal(fs.existsSync(file), false, 'nothing is visible before close');
  await out.close(true);
  assert.deepEqual(await readAll(file), [{ id: 1 }, { id: 2 }, { id: 3, name: 'c' }]);

  const src = await adapter.source!({ path: file }, io({ batchSize: 2 }));
  const sizes: number[] = [];
  for await (const batch of src.batches()) sizes.push(batch.length);
  assert.deepEqual(sizes, [2, 1]);
});

test('a failed pipe leaves nothing behind', async () => {
  const file = path.join(dir, 'failed.ndjson');
  const out = await adapter.sink!({ path: file }, io());
  await out.write([{ id: 1 }]);
  await out.close(false);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('a dry run changes nothing and says what it would do', async () => {
  const file = path.join(dir, 'dry.ndjson');
  logs.length = 0;
  const out = await adapter.sink!({ path: file }, io({ dryRun: true }));
  await out.write([{ id: 1 }, { id: 2 }]);
  await out.close(true);
  assert.equal(fs.existsSync(file), false);
  assert.match(logs.join('\n'), /would write 2 rows to .*dry\.ndjson/);
});

test('a bad config is refused with a message', async () => {
  await assert.rejects(() => adapter.source!({} as never, io()), /needs a path/);
  await assert.rejects(() => adapter.sink!({} as never, io()), /needs a path/);
});
