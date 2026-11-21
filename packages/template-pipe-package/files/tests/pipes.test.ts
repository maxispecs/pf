import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { makeSession, registerDbDrivers, type CompiledQuery, type DbDriver, type QueryResult } from '@pulpfixer/kit/db';
import { clearIoAdapters, registerIoAdapters } from '@pulpfixer/kit/io';
import { csvAdapter } from '@pulpfixer/plugin-csv/api';
import { dbAdapter, putConnection } from '@pulpfixer/plugin-db';
import { from, memoryAdapter, memorySink, memorySource, runPipe, stdoutAdapter } from '@pulpfixer/plugin-io/api';
import plugin, { shape } from '../src/index.js';

// A throwaway pf home: the tests never see the real connections.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-{{name}}-test-'));
process.env.PF_HOME = path.join(work, 'home');
process.env.NO_COLOR = '1';

const INPUT = '{{input}}' as string;
const OUTPUT = '{{output}}' as string;

/** A driver that runs nothing: it records each statement and answers with `respond`. */
function fakeDriver(respond: (q: CompiledQuery) => QueryResult) {
  const log: CompiledQuery[] = [];
  const driver: DbDriver = {
    id: 'fake',
    label: 'Fake',
    dialect: 'sqlite',
    forms: [{ id: 'params', label: 'Nothing to ask', fields: [] }],
    describe: () => 'fake',
    connect: async () =>
      makeSession(
        async (q) => {
          log.push(q);
          return respond(q);
        },
        async () => undefined,
      ),
  };
  registerDbDrivers([driver]);
  putConnection('{{connection}}', { driver: 'fake', form: 'params', params: {}, secrets: {} });
  return log;
}

/** Register the adapters the way pf does at startup. */
function adapters(): void {
  clearIoAdapters();
  registerIoAdapters([dbAdapter, csvAdapter, memoryAdapter, stdoutAdapter], 'test');
}

/** Run `pf {{name}} ...args` with stderr captured. */
async function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  const err: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => (typeof s === 'string' ? err.push(s) : se(s), true)) as typeof process.stderr.write;
  try {
    const code = await plugin.commands[0]!.run(buildContext(os.tmpdir()), args);
    return { code, stderr: err.join('') };
  } finally {
    process.stderr.write = se;
  }
}

test('shape passes a row through (replace it with the real change, and test it here)', () => {
  assert.deepEqual(shape({ id: 1, name: 'a' }), { id: 1, name: 'a' });
});

test('pf {{name}} lists its pipes', async () => {
  adapters();
  const r = await run();
  assert.equal(r.code, 0, r.stderr);
});

test('a pipe is plain code: run it on rows in memory, no adapter and no files', async () => {
  adapters();
  const out: Record<string, unknown>[] = [];
  const report = await runPipe(
    {
      label: '{{name}} copy',
      inputs: { source: memorySource([{ id: 1 }, { id: 2 }]) },
      outputs: { target: memorySink(out) },
      body: async ({ inputs, outputs }) => void (await from(inputs.source!).map(shape).to(outputs.target!)),
    },
    { ctx: buildContext(os.tmpdir()), yes: true },
  );
  assert.equal(report.ran, true);
  assert.deepEqual(report.written, { target: 2 });
  assert.deepEqual(out, [{ id: 1 }, { id: 2 }]);
});

test('copy runs through the {{input}} input and the {{output}} output', async () => {
  adapters();
  const rows = [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
  ];
  const log = fakeDriver((q) => (/^SELECT/.test(q.text) ? { rows } : { rows: [] }));

  let from = 'items';
  if (INPUT === 'csv') {
    from = path.join(work, 'in.csv');
    fs.writeFileSync(from, 'id,name\n1,a\n2,b\n');
  }
  const to = OUTPUT === 'csv' ? path.join(work, 'out.csv') : 'copy_of_items';

  const r = await run('copy', '--from', from, '--to', to, '--yes');
  assert.equal(r.code, 0, r.stderr);
  if (OUTPUT === 'csv') assert.equal(fs.readFileSync(to, 'utf8'), 'id,name\n1,a\n2,b\n');
  else assert.ok(log.some((q) => /INSERT INTO .*copy_of_items/.test(q.text)), log.map((q) => q.text).join('\n'));
  if (INPUT === 'db') assert.ok(log.some((q) => /^SELECT \* FROM .*items/.test(q.text)));
});

test('--dry-run reads but writes nothing', async () => {
  adapters();
  fakeDriver(() => ({ rows: [{ id: 1, name: 'a' }] }));
  const from = INPUT === 'csv' ? path.join(work, 'dry-in.csv') : 'items';
  if (INPUT === 'csv') fs.writeFileSync(from, 'id,name\n1,a\n');
  const to = OUTPUT === 'csv' ? path.join(work, 'dry-out.csv') : 'copy_of_items';
  const r = await run('copy', '--from', from, '--to', to, '--dry-run');
  assert.equal(r.code, 0, r.stderr);
  if (OUTPUT === 'csv') assert.equal(fs.existsSync(to), false);
});
