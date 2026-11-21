import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ioRef, type AnyIoAdapter, type IoContext, type Row } from '@pulpfixer/kit/io';
import { memorySink, memorySource } from '../src/adapters/memory.js';
import { IoError } from '../src/errors.js';
import { from } from '../src/flow.js';
import { runPipe, type PipeSpec } from '../src/run.js';
import { capture, ctx, freshAdapters, rows } from './helpers.js';

/** A recording adapter that can read and write and is not harmless. */
function recorder(id = 'rec') {
  const log: string[] = [];
  const state = { openContexts: [] as IoContext[], failOpen: false, failClose: false };
  const adapter: AnyIoAdapter = {
    id,
    label: 'Recorder',
    describe: (c: { name: string }) => `rec ${c.name}`,
    async source(c: { name: string; rows?: Row[] }, io) {
      state.openContexts.push(io);
      log.push(`open source ${c.name}`);
      return {
        batches: () =>
          (async function* () {
            yield c.rows ?? rows(3);
          })(),
        close: async () => void log.push(`close source ${c.name}`),
      };
    },
    async sink(c: { name: string }, io) {
      state.openContexts.push(io);
      if (state.failOpen) throw new Error('cannot open');
      log.push(`open sink ${c.name}`);
      return {
        write: async (b) => void log.push(`write ${c.name} ${b.length}`),
        close: async (ok) => {
          log.push(`close sink ${c.name} ${ok}`);
          if (state.failClose) throw new Error('cannot commit');
        },
      };
    },
  };
  return { adapter, log, state };
}

const copy = (r: ReturnType<typeof recorder>, extra: Partial<PipeSpec> = {}): PipeSpec => ({
  label: 'x copy',
  inputs: { src: ioRef(r.adapter.id, { name: 'in' }) },
  outputs: { dest: ioRef(r.adapter.id, { name: 'out' }) },
  body: async ({ inputs, outputs }) => void (await from(inputs.src!).to(outputs.dest!)),
  ...extra,
});

test('it opens inputs then outputs, runs, closes outputs with ok, then inputs, and counts rows', async () => {
  const r = recorder();
  freshAdapters(r.adapter);
  const lines: string[] = [];
  const report = await runPipe(copy(r), { ctx: ctx(), yes: true, say: (l) => lines.push(l) });
  assert.deepEqual(r.log, ['open source in', 'open sink out', 'write out 3', 'close sink out true', 'close source in']);
  assert.deepEqual(report, { read: { src: 3 }, written: { dest: 3 }, ran: true });
  assert.ok(lines.some((l) => l.includes('reads src: rec in')));
  assert.ok(lines.some((l) => l.includes('writes dest: rec out')));
  assert.ok(lines.some((l) => l.includes('wrote dest 3')));
});

test('without --yes and without a terminal it refuses to write and opens nothing', async () => {
  const r = recorder();
  freshAdapters(r.adapter);
  const lines: string[] = [];
  const result = await capture(async () => {
    const report = await runPipe(copy(r), { ctx: ctx(), say: (l) => lines.push(l) });
    return report.ran ? 0 : 1;
  });
  assert.equal(result.code, 1);
  assert.deepEqual(r.log, []);
  assert.match(result.stderr, /writes to rec out/);
  assert.match(result.stderr, /--yes/);
  assert.ok(lines.some((l) => l.includes('nothing was run')));
});

test('a dry run never asks, tells the adapters, and still reads', async () => {
  const r = recorder();
  freshAdapters(r.adapter);
  const lines: string[] = [];
  const report = await runPipe(copy(r), { ctx: ctx(), dryRun: true, say: (l) => lines.push(l) });
  assert.equal(report.ran, true);
  assert.ok(r.state.openContexts.every((io) => io.dryRun));
  assert.ok(lines.some((l) => l.includes('would write dest: rec out')));
  assert.ok(lines.some((l) => l.includes('would have written dest 3')));
});

test('harmless outputs are not asked about', async () => {
  freshAdapters();
  const out: Row[] = [];
  const report = await runPipe(
    {
      label: 'x',
      inputs: { src: memorySource(rows(2)) },
      outputs: { dest: memorySink(out) },
      body: async ({ inputs, outputs }) => void (await from(inputs.src!).to(outputs.dest!)),
    },
    { ctx: ctx(), say: () => undefined },
  );
  assert.equal(report.ran, true);
  assert.deepEqual(out, rows(2));
});

test('a failing body closes outputs with false, closes inputs, and throws the error', async () => {
  const r = recorder();
  freshAdapters(r.adapter);
  const lines: string[] = [];
  await assert.rejects(
    runPipe(
      copy(r, {
        body: async ({ inputs, outputs }) => {
          await from(inputs.src!).to(outputs.dest!);
          throw new Error('boom');
        },
      }),
      { ctx: ctx(), yes: true, say: (l) => lines.push(l) },
    ),
    /boom/,
  );
  assert.deepEqual(r.log, ['open source in', 'open sink out', 'write out 3', 'close sink out false', 'close source in']);
  assert.ok(lines.some((l) => l.includes('discarded dest 3')));
});

test('a failed memory output adds nothing', async () => {
  freshAdapters();
  const out: Row[] = [];
  await assert.rejects(
    runPipe(
      {
        label: 'x',
        inputs: { src: memorySource(rows(2)) },
        outputs: { dest: memorySink(out) },
        body: async ({ inputs, outputs }) => {
          await from(inputs.src!).to(outputs.dest!);
          throw new Error('late failure');
        },
      },
      { ctx: ctx(), say: () => undefined },
    ),
    /late failure/,
  );
  assert.deepEqual(out, []);
});

test('an output that fails to open closes the ones opened before it, with false', async () => {
  const r = recorder();
  freshAdapters(r.adapter);
  r.state.failOpen = true;
  await assert.rejects(runPipe(copy(r), { ctx: ctx(), yes: true, say: () => undefined }), /cannot open/);
  assert.deepEqual(r.log, ['open source in', 'close source in']);

  const two = recorder('two');
  freshAdapters(two.adapter);
  let n = 0;
  const original = two.adapter.sink!;
  two.adapter.sink = async (c, io) => {
    if (++n === 2) throw new Error('second sink broke');
    return original(c, io);
  };
  await assert.rejects(
    runPipe(
      { label: 'x', inputs: {}, outputs: { a: ioRef('two', { name: 'a' }), b: ioRef('two', { name: 'b' }) }, body: async () => undefined },
      { ctx: ctx(), yes: true, say: () => undefined },
    ),
    /second sink broke/,
  );
  assert.deepEqual(two.log, ['open sink a', 'close sink a false']);
});

test('when one output cannot commit, the ones after it are told to discard and the error is reported', async () => {
  const r = recorder();
  const second = recorder('second');
  freshAdapters(r.adapter, second.adapter);
  r.state.failClose = true;
  await assert.rejects(
    runPipe(
      {
        label: 'x',
        inputs: {},
        outputs: { a: ioRef('rec', { name: 'a' }), b: ioRef('second', { name: 'b' }) },
        body: async () => undefined,
      },
      { ctx: ctx(), yes: true, say: () => undefined },
    ),
    /closing output "a" failed: cannot commit/,
  );
  assert.deepEqual(second.log, ['open sink b', 'close sink b false']);
});

test('a missing adapter names the plugin to install, and says what is installed', async () => {
  freshAdapters();
  await assert.rejects(
    runPipe({ label: 'x', inputs: { a: ioRef('nope', {}) }, outputs: {}, body: async () => undefined }, { ctx: ctx(), say: () => undefined }),
    (e: unknown) => e instanceof IoError && /no IO adapter "nope".*input "a".*have: memory, stdout/.test(e.message) && e.hint === 'pf plugin install io-nope',
  );
});

test('an adapter that cannot read or write says so', async () => {
  freshAdapters();
  await assert.rejects(
    runPipe({ label: 'x', inputs: { a: ioRef('stdout', {}) }, outputs: {}, body: async () => undefined }, { ctx: ctx(), say: () => undefined }),
    /"stdout" adapter cannot be read from/,
  );
  await assert.rejects(
    runPipe({ label: 'x', inputs: {}, outputs: { a: ioRef('nothing', {}) }, body: async () => undefined }, { ctx: ctx(), say: () => undefined }),
    /no IO adapter "nothing"/,
  );
  const readOnly: AnyIoAdapter = { id: 'ro', label: 'RO', describe: () => 'ro', source: async () => ({ batches: () => (async function* () {})(), close: async () => undefined }) };
  freshAdapters(readOnly);
  await assert.rejects(
    runPipe({ label: 'x', inputs: {}, outputs: { a: ioRef('ro', {}) }, body: async () => undefined }, { ctx: ctx(), say: () => undefined }),
    /"ro" adapter cannot be written to/,
  );
});

test('a bad reference or configuration is explained before anything is opened', async () => {
  const r = recorder();
  freshAdapters(r.adapter);
  await assert.rejects(
    runPipe({ label: 'x', inputs: { a: { nope: true } as never }, outputs: {}, body: async () => undefined }, { ctx: ctx(), say: () => undefined }),
    /input "a" is not an IO reference/,
  );
  await assert.rejects(
    runPipe({ label: 'x', inputs: { a: ioRef('rec', null) }, outputs: {}, body: async () => undefined }, { ctx: ctx(), say: () => undefined }),
    /configuration of input "a" \(rec\) is not valid/,
  );
  assert.deepEqual(r.log, []);
});

test('the body cannot close what pf opened', async () => {
  const r = recorder();
  freshAdapters(r.adapter);
  await runPipe(
    copy(r, {
      body: async ({ inputs, outputs }) => {
        await from(inputs.src!).to(outputs.dest!);
        await outputs.dest!.close(true);
        await inputs.src!.close();
      },
    }),
    { ctx: ctx(), yes: true, say: () => undefined },
  );
  assert.equal(r.log.filter((l) => l.startsWith('close')).length, 2);
});
