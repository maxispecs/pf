import type { Context } from '@pulpfixer/kit/context';
import { ioAdapter, ioAdapters, type AnyIoAdapter, type IoContext, type IoRef, type IoSink, type IoSource, type Row } from '@pulpfixer/kit/io';
import { err } from '@pulpfixer/kit/ui/palette';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { IoError } from './errors.js';
import { DEFAULT_BATCH_SIZE } from './flow.js';

/** What a pipe body gets: its inputs and outputs, opened, under the names the pipe declared. */
export interface Handles {
  inputs: Record<string, IoSource>;
  outputs: Record<string, IoSink>;
}

export interface PipeSpec {
  /** Shown in prompts and the summary, e.g. `revrec monthly`. */
  label: string;
  inputs: Record<string, IoRef>;
  outputs: Record<string, IoRef>;
  body(handles: Handles, io: IoContext): Promise<unknown>;
}

export interface RunOptions {
  ctx: Context;
  dryRun?: boolean;
  /** Skip the confirmation before writing. */
  yes?: boolean;
  batchSize?: number;
  /** Where progress goes (default: stderr). */
  say?: (line: string) => void;
}

export interface RunReport {
  /** Rows each input handed out. */
  read: Record<string, number>;
  /** Rows each output was given (under `--dry-run` these are rows it would have written). */
  written: Record<string, number>;
  /** False when the run was declined at the confirmation. Nothing was opened. */
  ran: boolean;
}

const stderrSay = (line: string): void => void process.stderr.write(line + '\n');

function adapterFor(ref: IoRef, role: string, name: string): AnyIoAdapter {
  if (!ref || typeof ref !== 'object' || typeof ref.adapter !== 'string') {
    throw new IoError(`${role} "${name}" is not an IO reference (use the builders such as csvSource or dbSink)`);
  }
  const a = ioAdapter(ref.adapter);
  if (!a) {
    const have = ioAdapters().map((x) => x.id);
    throw new IoError(
      `no IO adapter "${ref.adapter}" is installed (${role} "${name}")${have.length ? `, have: ${have.join(', ')}` : ''}`,
      `pf plugin install io-${ref.adapter}`,
    );
  }
  return a;
}

function describe(a: AnyIoAdapter, ref: IoRef, role: string, name: string): string {
  try {
    return a.describe(ref.config);
  } catch (e) {
    throw new IoError(`the configuration of ${role} "${name}" (${a.id}) is not valid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function countedSource(source: IoSource, counter: { n: number }): IoSource {
  return {
    batches() {
      const batches = source.batches();
      return (async function* () {
        for await (const batch of batches) {
          counter.n += batch.length;
          yield batch;
        }
      })();
    },
    // pf closes sources when the pipe is over
    close: async () => undefined,
  };
}

function countedSink(sink: IoSink, counter: { n: number }): IoSink {
  return {
    async write(batch: Row[]) {
      await sink.write(batch);
      counter.n += batch.length;
    },
    // pf closes sinks when the pipe is over, saying whether it worked
    close: async () => undefined,
  };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The life of one pipe run:
 *   1. find the adapter of every input and output (a missing one names the plugin to install);
 *   2. show where it reads and writes, and ask before writing (`yes` skips it, a dry run never asks,
 *      without a terminal it refuses; outputs of harmless adapters are not asked about);
 *   3. open the inputs, then the outputs;
 *   4. run the body;
 *   5. close the outputs, telling each whether the run worked (a failed run rolls back / discards), then the inputs;
 *   6. say how many rows were read and written.
 * A failure anywhere closes everything that was opened and is thrown after that.
 */
export async function runPipe(spec: PipeSpec, opts: RunOptions): Promise<RunReport> {
  const say = opts.say ?? stderrSay;
  const dryRun = opts.dryRun === true;
  const c = err();
  const report: RunReport = { read: {}, written: {}, ran: false };

  const inputs = Object.entries(spec.inputs).map(([name, ref]) => {
    const adapter = adapterFor(ref, 'input', name);
    if (!adapter.source) throw new IoError(`the "${adapter.id}" adapter cannot be read from (input "${name}")`);
    return { name, ref, adapter, line: describe(adapter, ref, 'input', name) };
  });
  const outputs = Object.entries(spec.outputs).map(([name, ref]) => {
    const adapter = adapterFor(ref, 'output', name);
    if (!adapter.sink) throw new IoError(`the "${adapter.id}" adapter cannot be written to (output "${name}")`);
    return { name, ref, adapter, line: describe(adapter, ref, 'output', name) };
  });

  for (const i of inputs) say(`${c.dim('reads')} ${i.name}: ${i.line}`);
  for (const o of outputs) say(`${c.dim(dryRun ? 'would write' : 'writes')} ${o.name}: ${o.line}`);

  const asks = outputs.filter((o) => !o.adapter.harmless);
  if (asks.length && !dryRun && !opts.yes) {
    const where = asks.map((o) => o.line).join(', ');
    if (!(await confirm(`"${spec.label}" writes to ${where}. Run it?`, false, { flag: '--yes' }))) {
      say(c.dim('nothing was run'));
      return report;
    }
  }
  report.ran = true;

  const io: IoContext = { ctx: opts.ctx, dryRun, log: (line) => say(c.dim(line)), batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE };
  const openSources: { name: string; source: IoSource }[] = [];
  const openSinks: { name: string; sink: IoSink }[] = [];
  let failure: unknown;
  let failed = false;
  const fail = (e: unknown): void => {
    if (!failed) {
      failed = true;
      failure = e;
    }
  };

  try {
    for (const i of inputs) openSources.push({ name: i.name, source: await i.adapter.source!(i.ref.config, io) });
    for (const o of outputs) openSinks.push({ name: o.name, sink: await o.adapter.sink!(o.ref.config, io) });
    const readCounters = Object.fromEntries(openSources.map((s) => [s.name, { n: 0 }]));
    const writeCounters = Object.fromEntries(openSinks.map((s) => [s.name, { n: 0 }]));
    const handles: Handles = {
      inputs: Object.fromEntries(openSources.map((s) => [s.name, countedSource(s.source, readCounters[s.name]!)])),
      outputs: Object.fromEntries(openSinks.map((s) => [s.name, countedSink(s.sink, writeCounters[s.name]!)])),
    };
    try {
      await spec.body(handles, io);
    } finally {
      for (const [k, v] of Object.entries(readCounters)) report.read[k] = v.n;
      for (const [k, v] of Object.entries(writeCounters)) report.written[k] = v.n;
    }
  } catch (e) {
    fail(e);
  }

  // Outputs first: if one cannot be committed, the ones after it are told to discard.
  for (const { name, sink } of openSinks) {
    try {
      await sink.close(!failed);
    } catch (e) {
      fail(new IoError(`closing output "${name}" failed: ${msg(e)}`));
    }
  }
  for (const { source } of openSources) await source.close().catch(() => undefined);

  const rows = (counts: Record<string, number>) => Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ');
  if (Object.keys(report.read).length) say(`${c.dim('read')} ${rows(report.read)} ${c.dim('rows')}`);
  if (Object.keys(report.written).length) say(`${c.dim(dryRun ? 'would have written' : failed ? 'discarded' : 'wrote')} ${rows(report.written)} ${c.dim('rows')}`);
  if (failed) throw failure;
  return report;
}
