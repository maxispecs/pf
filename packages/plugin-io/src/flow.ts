import type { IoSink, IoSource, Row, RowBatches } from '@pulpfixer/kit/io';
import { IoError } from './errors.js';

export const DEFAULT_BATCH_SIZE = 500;

/** What `from` accepts: a flow, an opened source, rows in an array, or an async iterable of row batches. */
export type FlowSource = Flow | IoSource | readonly Row[] | RowBatches;

export interface ToResult {
  rows: number;
  batches: number;
}

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkSize(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 1) throw new IoError(`${what} needs a whole number of at least 1 (got ${String(n)})`);
}

/**
 * Rows on their way from a source to sinks, in batches. A flow is lazy (nothing is read until `to`,
 * `collect` or `count`) and can be read once: every step returns a new flow and uses up the one before.
 * Use `to(a, b)` to send the same rows to several sinks.
 */
export class Flow implements AsyncIterable<Row[]> {
  private used = false;

  constructor(
    private readonly make: () => RowBatches,
    readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<Row[]> {
    return this.claim()()[Symbol.asyncIterator]();
  }

  private claim(): () => RowBatches {
    if (this.used) throw new IoError('this flow was already used: a flow is read once (send rows to several sinks with .to(a, b))');
    this.used = true;
    return this.make;
  }

  private chain(step: (batches: RowBatches) => RowBatches): Flow {
    const make = this.claim();
    return new Flow(() => step(make()), this.batchSize);
  }

  private each(fn: (row: Row, index: number) => Row[] | Promise<Row[]>): Flow {
    return this.chain((batches) =>
      (async function* () {
        let i = 0;
        for await (const batch of batches) {
          const out: Row[] = [];
          for (const row of batch) out.push(...(await fn(row, i++)));
          if (out.length) yield out;
        }
      })(),
    );
  }

  /** Replace each row. `fn` must return a row (an object); to drop rows use `filter` or `flatMap`. */
  map(fn: (row: Row, index: number) => Row | Promise<Row>): Flow {
    return this.each(async (row, i) => {
      const r = await fn(row, i);
      if (!isRow(r)) throw new IoError(`map must return a row (an object), it returned ${r === null ? 'null' : typeof r}: use filter to drop rows`);
      return [r];
    });
  }

  filter(fn: (row: Row, index: number) => boolean | Promise<boolean>): Flow {
    return this.each(async (row, i) => ((await fn(row, i)) ? [row] : []));
  }

  /** Replace each row with any number of rows. */
  flatMap(fn: (row: Row, index: number) => Row[] | Promise<Row[]>): Flow {
    return this.each(async (row, i) => {
      const rows = await fn(row, i);
      if (!Array.isArray(rows) || !rows.every(isRow)) throw new IoError('flatMap must return an array of rows');
      return rows;
    });
  }

  /** Look at each row (count, log) and pass it on unchanged. */
  tap(fn: (row: Row, index: number) => void | Promise<void>): Flow {
    return this.each(async (row, i) => {
      await fn(row, i);
      return [row];
    });
  }

  /** Keep only these columns (a missing one is left out). */
  pick(...columns: string[]): Flow {
    return this.each((row) => [Object.fromEntries(columns.filter((c) => Object.hasOwn(row, c)).map((c) => [c, row[c]]))]);
  }

  /** Drop these columns. */
  omit(...columns: string[]): Flow {
    const drop = new Set(columns);
    return this.each((row) => [Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k)))]);
  }

  /** Rename columns: `{ old_name: 'newName' }`. Other columns keep their names and order. */
  rename(names: Record<string, string>): Flow {
    return this.each((row) => [Object.fromEntries(Object.entries(row).map(([k, v]) => [Object.hasOwn(names, k) ? names[k]! : k, v]))]);
  }

  /** The first `n` rows; the source is not read further. */
  take(n: number): Flow {
    if (!Number.isInteger(n) || n < 0) throw new IoError(`take needs a whole number of 0 or more (got ${String(n)})`);
    return this.chain((batches) =>
      (async function* () {
        if (n === 0) return;
        let left = n;
        for await (const batch of batches) {
          const part = batch.length > left ? batch.slice(0, left) : batch;
          if (part.length) yield part;
          left -= part.length;
          if (left <= 0) return;
        }
      })(),
    );
  }

  /** Regroup the rows into batches of `n` (the last one may be smaller). */
  batch(n: number): Flow {
    checkSize(n, 'batch');
    const make = this.claim();
    return new Flow(
      () =>
        (async function* () {
          let buf: Row[] = [];
          for await (const batch of make()) {
            for (const row of batch) {
              buf.push(row);
              if (buf.length >= n) {
                yield buf;
                buf = [];
              }
            }
          }
          if (buf.length) yield buf;
        })(),
      n,
    );
  }

  /** The rows one by one. */
  rows(): AsyncIterable<Row> {
    const make = this.claim();
    return (async function* () {
      for await (const batch of make()) yield* batch;
    })();
  }

  /** Write every batch to every sink, in order (a tee when there are several). Closing the sinks is up to whoever opened them. */
  async to(...sinks: IoSink[]): Promise<ToResult> {
    if (sinks.length === 0) throw new IoError('to() needs at least one sink');
    const make = this.claim();
    let rows = 0;
    let batches = 0;
    for await (const batch of make()) {
      if (batch.length === 0) continue;
      for (const sink of sinks) await sink.write(batch);
      rows += batch.length;
      batches++;
    }
    return { rows, batches };
  }

  /** Every row in an array. Only for results that fit in memory. */
  async collect(): Promise<Row[]> {
    const out: Row[] = [];
    for await (const batch of this.claim()()) out.push(...batch);
    return out;
  }

  async count(): Promise<number> {
    let n = 0;
    for await (const batch of this.claim()()) n += batch.length;
    return n;
  }
}

const isIoSource = (v: unknown): v is IoSource => typeof v === 'object' && v !== null && typeof (v as IoSource).batches === 'function';

function chunks(rows: readonly Row[], size: number): RowBatches {
  return (async function* () {
    for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
  })();
}

/** Start a chain: `from(inputs.orders).map(...).to(outputs.report)`. */
export function from(source: FlowSource, batchSize: number = DEFAULT_BATCH_SIZE): Flow {
  checkSize(batchSize, 'the batch size');
  if (source instanceof Flow) return source;
  if (isIoSource(source)) return new Flow(() => source.batches(), batchSize);
  if (Array.isArray(source)) return new Flow(() => chunks(source, batchSize), batchSize);
  if (source && typeof (source as RowBatches)[Symbol.asyncIterator] === 'function') return new Flow(() => source as RowBatches, batchSize);
  throw new IoError('from() takes a source, a flow, an array of rows or an async iterable of row batches');
}

/** Rows one by one (an iterable or async iterable of objects) cut into batches. */
export function fromRows(rows: Iterable<Row> | AsyncIterable<Row>, batchSize: number = DEFAULT_BATCH_SIZE): Flow {
  checkSize(batchSize, 'the batch size');
  return new Flow(
    () =>
      (async function* () {
        let buf: Row[] = [];
        for await (const row of rows) {
          buf.push(row);
          if (buf.length >= batchSize) {
            yield buf;
            buf = [];
          }
        }
        if (buf.length) yield buf;
      })(),
    batchSize,
  );
}

/** The sources one after the other as one flow. */
export function concat(...sources: FlowSource[]): Flow {
  const flows = sources.map((s) => from(s));
  return new Flow(() =>
    (async function* () {
      for (const f of flows) yield* f;
    })(),
  );
}

export const collect = (flow: Flow): Promise<Row[]> => flow.collect();
export const count = (flow: Flow): Promise<number> => flow.count();
