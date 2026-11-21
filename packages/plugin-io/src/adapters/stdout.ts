import { cellText, columnsOf, encodeCsvLine } from '@pulpfixer/kit/csv';
import { ioRef, type IoAdapter, type IoRef, type Row } from '@pulpfixer/kit/io';
import { out } from '@pulpfixer/kit/ui/palette';
import { table } from '@pulpfixer/kit/ui/text';

export const STDOUT_FORMATS = ['ndjson', 'csv', 'table'] as const;
export type StdoutFormat = (typeof STDOUT_FORMATS)[number];

export interface StdoutConfig {
  /** `ndjson` (default): one JSON object per line. `csv`: header, then rows. `table`: printed when the pipe is over. */
  format?: StdoutFormat;
}

const json = (row: Row): string => JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

const write = (s: string): void => void process.stdout.write(s);

/** Rows to the terminal (stdout), so a pipe's result can be piped on. Progress goes to stderr. */
export const stdoutAdapter: IoAdapter<StdoutConfig> = {
  id: 'stdout',
  label: 'Standard output',
  harmless: true,
  describe(c) {
    const format = c?.format ?? 'ndjson';
    if (!STDOUT_FORMATS.includes(format)) throw new Error(`format must be one of ${STDOUT_FORMATS.join(', ')} (got "${String(format)}")`);
    return `standard output (${format})`;
  },
  async sink(config, io) {
    const format = config?.format ?? 'ndjson';
    if (!STDOUT_FORMATS.includes(format)) throw new Error(`format must be one of ${STDOUT_FORMATS.join(', ')} (got "${String(format)}")`);
    if (io.dryRun) {
      let n = 0;
      return {
        write: async (batch) => void (n += batch.length),
        close: async () => io.log(`would print ${n} rows as ${format}`),
      };
    }
    let columns: string[] | null = null;
    const held: Row[] = [];
    return {
      async write(batch) {
        if (format === 'ndjson') return write(batch.map((r) => json(r) + '\n').join(''));
        if (format === 'csv') {
          let text = '';
          if (!columns) {
            columns = columnsOf(batch);
            text += encodeCsvLine(columns) + '\n';
          }
          const cols = columns;
          text += batch.map((r) => encodeCsvLine(cols.map((k) => cellText(r[k]))) + '\n').join('');
          return write(text);
        }
        held.push(...batch);
      },
      async close(ok) {
        if (format !== 'table' || !ok || held.length === 0) return;
        const cols = columnsOf(held);
        write(table(cols, held.map((r) => cols.map((k) => cellText(r[k]))), out()) + '\n');
      },
    };
  },
};

/** An output that prints rows on stdout. */
export const stdoutSink = (format: StdoutFormat = 'ndjson'): IoRef<StdoutConfig> => ioRef('stdout', { format });
