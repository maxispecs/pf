import type { Plugin } from '@pulpfixer/kit/plugin';
import { csvAdapter } from './adapter.js';
import { csvCommand } from './commands/csv.js';

export * from './api.js';
export { csvCommand } from './commands/csv.js';

/**
 * CSV files for pipes: the `csv` IO adapter (a streaming source, a sink that replaces the file only when the
 * pipe has worked) and `pf csv show|columns` to look at a file. Pipe packages use `csvSource` / `csvSink`
 * from `@pulpfixer/plugin-csv/api`. It has no agent tools: files hold user data.
 */
export const csvPlugin: Plugin = {
  name: 'csv',
  api: 3,
  summary: 'Read and write CSV files: the csv adapter for pipes, pf csv show / columns',
  commands: [csvCommand],
  ioAdapters: [csvAdapter],
  entries: (ctx) => [{ name: 'csv', summary: 'Look at CSV files: show, columns', group: 'Tools', run: () => csvCommand.run(ctx, []) }],
};
