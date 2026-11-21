import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ioRef, type IoAdapter, type IoRef, type Row } from '@pulpfixer/kit/io';

/** What a pipe gives this adapter. Replace it with what your adapter needs (a URL, a bucket, a table...). */
export interface Config {
  /** The JSON Lines file. */
  path: string;
}

const ID = '{{name}}';

function check(config: unknown): Config {
  const c = config as Partial<Config> | null;
  if (!c || typeof c !== 'object' || typeof c.path !== 'string' || c.path === '') throw new Error('the {{name}} adapter needs a path');
  return c as Config;
}

/**
 * The sample: JSON Lines files (one JSON object per line). It shows the whole contract:
 * - `source` streams batches of `io.batchSize` rows and never reads the whole input at once;
 * - `sink.write` takes batches in order, nothing is visible at the target until `close(true)`;
 * - `close(false)` (the pipe failed) discards everything;
 * - under `io.dryRun` a sink changes nothing and says what it would do through `io.log`;
 * - `describe` is one safe line (never a secret) for the confirmation question.
 */
export const adapter: IoAdapter<Config> = {
  id: ID,
  label: '{{summary}}',
  describe: (config) => `{{name}} file ${(config as Partial<Config> | null)?.path ?? '?'}`,

  async source(config, io) {
    const c = check(config);
    return {
      batches: () =>
        (async function* () {
          const lines = readline.createInterface({ input: fs.createReadStream(c.path, 'utf8'), crlfDelay: Infinity });
          let batch: Row[] = [];
          try {
            for await (const line of lines) {
              if (line.trim() === '') continue;
              batch.push(JSON.parse(line) as Row);
              if (batch.length >= io.batchSize) {
                yield batch;
                batch = [];
              }
            }
          } finally {
            lines.close();
          }
          if (batch.length > 0) yield batch;
        })(),
      close: async () => undefined,
    };
  },

  async sink(config, io) {
    const c = check(config);
    if (io.dryRun) {
      let rows = 0;
      return {
        write: async (batch) => void (rows += batch.length),
        close: async (ok) => {
          if (ok) io.log(`would write ${rows} rows to ${c.path}`);
        },
      };
    }
    const tmp = `${c.path}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(path.resolve(c.path)), { recursive: true });
    const out = fs.createWriteStream(tmp, { flags: 'wx', encoding: 'utf8' });
    const done = new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.once('close', resolve);
    });
    const end = (): Promise<void> => {
      out.end();
      return done;
    };
    return {
      async write(batch) {
        const text = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
        if (!out.write(text)) await new Promise<void>((resolve) => out.once('drain', resolve));
      },
      async close(ok) {
        await end();
        if (ok) fs.renameSync(tmp, c.path);
        else fs.rmSync(tmp, { force: true });
      },
    };
  },
};

/** An input of this adapter, for `inputs: { rows: source({ path }) }` in a pipe. */
export const source = (config: Config): IoRef<Config> => ioRef(ID, config);
/** An output of this adapter, for `outputs: { out: sink({ path }) }` in a pipe. */
export const sink = (config: Config): IoRef<Config> => ioRef(ID, config);
