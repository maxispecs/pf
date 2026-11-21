import type { IoAdapter, IoRef, Row } from '@pulpfixer/kit/io';
import { ioRef } from '@pulpfixer/kit/io';

export interface MemoryConfig {
  /** The rows to read, or the array a sink adds its rows to. */
  rows: Row[];
}

/**
 * Rows in an array: for tests of pipes and for small glue code. As an output it keeps what it is given
 * until the pipe has worked; a failed pipe adds nothing, like a rolled back transaction.
 */
export const memoryAdapter: IoAdapter<MemoryConfig> = {
  id: 'memory',
  label: 'Rows in memory (tests)',
  harmless: true,
  describe: (c) => `memory (${Array.isArray(c?.rows) ? c.rows.length : '?'} rows)`,
  async source(config, io) {
    if (!Array.isArray(config?.rows)) throw new Error('memory needs a rows array');
    const rows = config.rows;
    return {
      batches: () =>
        (async function* () {
          for (let i = 0; i < rows.length; i += io.batchSize) yield rows.slice(i, i + io.batchSize);
        })(),
      close: async () => undefined,
    };
  },
  async sink(config) {
    if (!Array.isArray(config?.rows)) throw new Error('memory needs a rows array');
    const pending: Row[] = [];
    return {
      write: async (batch) => void pending.push(...batch),
      close: async (ok) => {
        if (ok) config.rows.push(...pending);
      },
    };
  },
};

/** An input that reads `rows`. */
export const memorySource = (rows: Row[]): IoRef<MemoryConfig> => ioRef('memory', { rows });
/** An output that adds its rows to `rows` once the pipe has worked. */
export const memorySink = (rows: Row[]): IoRef<MemoryConfig> => ioRef('memory', { rows });
