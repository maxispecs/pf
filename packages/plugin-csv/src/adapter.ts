import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { CsvParser, cellText, checkDelimiter, columnsOf, encodeCsvLine } from '@pulpfixer/kit/csv';
import { ioRef, type IoAdapter, type IoContext, type IoRef, type IoSink, type IoSource, type Row, type RowBatches } from '@pulpfixer/kit/io';

/** A problem with a CSV file or its configuration. */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

export const CSV_MODES = ['create', 'overwrite', 'append'] as const;
export type CsvMode = (typeof CSV_MODES)[number];

interface CsvCommon {
  /** The file, or `-` for standard input (a source) / standard output (a sink). */
  path: string;
  /** One character, `,` by default (`'\t'` for TSV). */
  delimiter?: string;
}

export interface CsvSourceConfig extends CsvCommon {
  /** The first line holds the column names (default true). */
  header?: boolean;
  /** The column names. Without a header they name the fields; with a header they replace the names in it. */
  columns?: string[];
}

export interface CsvSinkConfig extends CsvCommon {
  /** The columns and their order. Default: the keys of the first batch (later rows may not add more). */
  columns?: string[];
  /** `create` (default) refuses a file that exists, `overwrite` replaces it, `append` adds to it. */
  mode?: CsvMode;
  /** Write the header line (default true; not written again when appending to a file that has one). */
  header?: boolean;
}

export type CsvConfig = CsvSourceConfig | CsvSinkConfig;

const STDIO = '-';

function checkCommon(config: unknown, what: string): CsvConfig {
  const c = config as Partial<CsvSourceConfig & CsvSinkConfig> | null;
  if (!c || typeof c !== 'object') throw new CsvError(`the csv ${what} needs a configuration object`);
  if (typeof c.path !== 'string' || c.path === '') throw new CsvError(`the csv ${what} needs a path (or "-" for standard input/output)`);
  if (c.delimiter !== undefined) {
    const bad = typeof c.delimiter === 'string' ? checkDelimiter(c.delimiter) : 'delimiter must be a string';
    if (bad) throw new CsvError(bad);
  }
  if (c.columns !== undefined) {
    if (!Array.isArray(c.columns) || c.columns.length === 0 || !c.columns.every((n) => typeof n === 'string' && n !== '')) throw new CsvError('columns must be a list of column names');
    if (new Set(c.columns).size !== c.columns.length) throw new CsvError('columns lists a name twice');
  }
  if (c.header !== undefined && typeof c.header !== 'boolean') throw new CsvError('header must be true or false');
  return c as CsvConfig;
}

const errnoCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return null;
    throw e;
  }
}

/** Names from a header line: each needs a name and the names must differ. */
function headerNames(record: string[]): string[] {
  const seen = new Set<string>();
  record.forEach((name, i) => {
    if (name === '') throw new CsvError(`column ${i + 1} of the header has no name (set columns to name the columns yourself)`);
    if (seen.has(name)) throw new CsvError(`the column "${name}" is in the header twice (set columns to rename them)`);
    seen.add(name);
  });
  return record;
}

async function openSource(config: unknown, io: IoContext): Promise<IoSource> {
  const c = checkCommon(config, 'source') as CsvSourceConfig;
  const stdin = c.path === STDIO;
  const file = path.resolve(c.path);
  if (!stdin) {
    const st = await statOrNull(file).catch((e: unknown) => {
      throw new CsvError(`cannot read ${c.path}: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!st) throw new CsvError(`the CSV file ${c.path} does not exist`);
    if (!st.isFile()) throw new CsvError(`${c.path} is not a file`);
  }
  const held: { stream: Readable | null } = { stream: null };
  let used = false;

  const batches = (): RowBatches =>
    (async function* () {
      if (used) throw new CsvError('a CSV source can be read once');
      used = true;
      const input: Readable = stdin ? process.stdin : fs.createReadStream(file);
      held.stream = input;
      input.setEncoding('utf8');
      const parser = new CsvParser(c.delimiter ?? ',');
      let columns: string[] | null = c.columns ? [...c.columns] : null;
      let headerPending = c.header !== false;
      let record = 0;
      let batch: Row[] = [];

      const toRow = (rec: string[]): Row | null => {
        record++;
        if (headerPending) {
          headerPending = false;
          if (c.columns && rec.length !== c.columns.length) throw new CsvError(`the header of ${c.path} has ${rec.length} columns, columns lists ${c.columns.length}`);
          columns ??= headerNames(rec);
          return null;
        }
        columns ??= rec.map((_, i) => `column${i + 1}`);
        if (rec.length !== columns.length) throw new CsvError(`${c.path}: record ${record} has ${rec.length} value${rec.length === 1 ? '' : 's'}, expected ${columns.length}`);
        return Object.fromEntries(columns.map((name, i) => [name, rec[i]!]));
      };

      try {
        for await (const chunk of input) {
          for (const rec of parser.push(chunk as string)) {
            const row = toRow(rec);
            if (row) batch.push(row);
            if (batch.length >= io.batchSize) {
              yield batch;
              batch = [];
            }
          }
        }
        for (const rec of parser.end()) {
          const row = toRow(rec);
          if (row) batch.push(row);
        }
      } catch (e) {
        if (e instanceof CsvError) throw e;
        if (errnoCode(e)) throw new CsvError(`cannot read ${c.path}: ${e instanceof Error ? e.message : String(e)}`);
        throw new CsvError(`${c.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (batch.length) yield batch;
    })();

  return {
    batches,
    close: async () => {
      if (held.stream && !stdin) held.stream.destroy();
    },
  };
}

/** Turns rows into CSV lines: the columns come from the config or the first batch, the header goes first. */
class Encoder {
  columns: string[] | null;
  private headerPending: boolean;
  private readonly delimiter: string;

  constructor(c: CsvSinkConfig, opts: { columns?: string[] | null; header: boolean }) {
    this.columns = opts.columns ?? c.columns ?? null;
    this.headerPending = opts.header;
    this.delimiter = c.delimiter ?? ',';
  }

  encode(batch: readonly Row[]): string {
    this.columns ??= columnsOf(batch);
    const cols = this.columns;
    let text = '';
    if (this.headerPending) {
      this.headerPending = false;
      text += encodeCsvLine(cols, this.delimiter) + '\n';
    }
    for (const row of batch) {
      for (const k of Object.keys(row)) {
        if (!cols.includes(k)) {
          throw new CsvError(`a row has the column "${k}", which is not in the header (${cols.join(', ')}): list every column in columns`);
        }
      }
      text += encodeCsvLine(cols.map((k) => cellText(row[k])), this.delimiter) + '\n';
    }
    return text;
  }

  /** What is still owed when there were no rows: the header, when the columns are known. */
  finish(): string {
    if (!this.headerPending || !this.columns) return '';
    this.headerPending = false;
    return encodeCsvLine(this.columns, this.delimiter) + '\n';
  }
}

/** The first record of a file (its header), or null when it is empty. */
export async function readFirstRecord(file: string, delimiter = ','): Promise<string[] | null> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const parser = new CsvParser(delimiter);
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(64 * 1024);
    for (let pos = 0; pos < 16 * 1024 * 1024; ) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const records = parser.push(decoder.write(buf.subarray(0, bytesRead)));
      if (records[0]) return records[0];
    }
    return parser.end()[0] ?? null;
  } finally {
    await fh.close();
  }
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

async function endsWithNewline(file: string): Promise<boolean> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return true;
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, size - 1);
    return b[0] === 0x0a || b[0] === 0x0d;
  } finally {
    await fh.close();
  }
}

/** Put the finished file at `target` without ever replacing one that is there (`create`). */
async function linkNew(tmp: string, target: string, shown: string): Promise<void> {
  const exists = new CsvError(`${shown} appeared while the pipe ran; mode "create" never replaces a file`);
  try {
    await fs.promises.link(tmp, target);
  } catch (e) {
    if (errnoCode(e) === 'EEXIST') throw exists;
    // A file system without hard links: check, then move.
    if (await statOrNull(target)) throw exists;
    await fs.promises.rename(tmp, target);
  }
}

async function openSink(config: unknown, io: IoContext): Promise<IoSink> {
  const c = checkCommon(config, 'sink') as CsvSinkConfig;
  const mode = c.mode ?? 'create';
  if (!CSV_MODES.includes(mode)) throw new CsvError(`mode must be one of ${CSV_MODES.join(', ')} (got "${String(mode)}")`);
  const header = c.header !== false;

  if (c.path === STDIO) {
    const encoder = new Encoder(c, { header });
    let rows = 0;
    return {
      async write(batch) {
        if (batch.length === 0) return;
        const text = encoder.encode(batch);
        rows += batch.length;
        if (!io.dryRun) process.stdout.write(text);
      },
      async close(ok) {
        if (io.dryRun) return io.log(`would print ${rows} rows as CSV`);
        if (ok) {
          const rest = encoder.finish();
          if (rest) process.stdout.write(rest);
        }
      },
    };
  }

  const target = path.resolve(c.path);
  const dir = path.dirname(target);
  const dirStat = await statOrNull(dir);
  if (!dirStat?.isDirectory()) throw new CsvError(`the folder ${dir} does not exist`);
  const existing = await statOrNull(target);
  if (existing && !existing.isFile()) throw new CsvError(`${c.path} is not a file`);
  if (existing && mode === 'create') throw new CsvError(`${c.path} already exists: mode "create" never replaces a file (use mode "overwrite" or "append")`);

  // Appending to a file that has a header: the rows must line up with it, and it is not written twice.
  let columns: string[] | null = null;
  let writeHeader = header;
  const appending = mode === 'append' && existing !== null && existing.size > 0;
  if (appending && header) {
    const first = await readFirstRecord(target, c.delimiter ?? ',');
    if (first) {
      if (c.columns && !same(first, c.columns)) throw new CsvError(`${c.path} has the columns ${first.join(', ')}, columns says ${c.columns.join(', ')}`);
      columns = first;
      writeHeader = false;
    }
  }
  const encoder = new Encoder(c, { columns, header: writeHeader });

  if (io.dryRun) {
    let rows = 0;
    return {
      async write(batch) {
        if (batch.length) {
          encoder.encode(batch); // checks the columns, like a real run
          rows += batch.length;
        }
      },
      close: async () => {
        const n = `${rows} row${rows === 1 ? '' : 's'}`;
        io.log(appending ? `would append ${n} to ${c.path}` : existing ? `would replace ${c.path} with ${n}` : `would write ${n} to ${c.path}`);
      },
    };
  }

  const tmp = path.join(dir, `.${path.basename(target)}.pf-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.promises.open(tmp, 'wx');
  if (existing && mode === 'overwrite') await handle.chmod(existing.mode & 0o777).catch(() => undefined);
  let closed = false;
  const discard = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await handle.close().catch(() => undefined);
    }
    await fs.promises.rm(tmp, { force: true });
  };

  return {
    async write(batch) {
      if (batch.length === 0) return;
      await handle.write(encoder.encode(batch));
    },
    async close(ok) {
      if (!ok) return discard();
      try {
        const rest = encoder.finish();
        if (rest) await handle.write(rest);
        await handle.close();
        closed = true;
        if (appending) {
          if (!(await endsWithNewline(target))) await fs.promises.appendFile(target, '\n');
          await pipeline(fs.createReadStream(tmp), fs.createWriteStream(target, { flags: 'a' }));
        } else if (existing) {
          // overwrite, or append to a file with nothing in it
          await fs.promises.rename(tmp, target);
        } else {
          await linkNew(tmp, target, c.path);
        }
      } finally {
        await discard();
      }
    },
  };
}

/**
 * CSV files (RFC 4180) as rows. A source streams the file in batches; values are strings (a pipe converts
 * them). A sink writes a temporary file next to the target and moves it into place when the pipe has worked,
 * so a failed pipe leaves the target as it was (`append` copies the new lines on at the end instead). `-` is
 * standard input or output.
 */
export const csvAdapter: IoAdapter<CsvConfig> = {
  id: 'csv',
  label: 'CSV file',
  describe(config) {
    const c = config as Partial<CsvSinkConfig> | null;
    if (!c || typeof c.path !== 'string') return 'csv file (?)';
    const mode = c.mode ? ` (${c.mode})` : '';
    return c.path === STDIO ? 'csv on standard input/output' : `csv file ${c.path}${mode}`;
  },
  source: openSource,
  sink: openSink,
};

/** An input that reads a CSV file. */
export const csvSource = (config: CsvSourceConfig): IoRef<CsvSourceConfig> => ioRef('csv', config);

/** An output that writes a CSV file (`mode` defaults to `create`, which refuses an existing file). */
export const csvSink = (config: CsvSinkConfig): IoRef<CsvSinkConfig> => ioRef('csv', { mode: 'create', ...config });
