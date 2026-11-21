import { ioAdapters } from '@pulpfixer/kit/io';
import type { Plugin } from '@pulpfixer/kit/plugin';
import type { Entry } from '@pulpfixer/kit/types';
import { memoryAdapter } from './adapters/memory.js';
import { stdoutAdapter } from './adapters/stdout.js';
import { ioCommand } from './commands/io.js';

export * from './api.js';
export { ioCommand } from './commands/io.js';

/**
 * IO adapters and pipes. An adapter (the database in `plugin-db`, CSV files in `plugin-csv`, others from
 * `@pulpfixer/io-<name>` registry plugins) opens rows to read or write; a pipe package
 * (`@pulpfixer/pipe-<name>`, built with `definePipes` from `@pulpfixer/plugin-io/api`) declares its inputs
 * and outputs and does the coupling in code. `pf io` lists the adapters. It carries the `memory` and
 * `stdout` adapters. It has no agent tools: pipes move user data.
 */
export const ioPlugin: Plugin = {
  name: 'io',
  api: 3,
  summary: 'IO adapters and pipes: move rows between databases, CSV files and more',
  commands: [ioCommand],
  ioAdapters: [memoryAdapter, stdoutAdapter],
  entries(ctx): Entry[] {
    const n = ioAdapters().length;
    return [{ name: 'io', summary: 'IO adapters for pipes: list', group: 'Tools', detail: `${n} adapter${n === 1 ? '' : 's'}`, run: () => ioCommand.run(ctx, []) }];
  },
};
