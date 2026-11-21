import { adapter } from './adapter.js';

export { adapter, source, sink, type Config } from './adapter.js';

/**
 * pf loads this when `@pulpfixer/io-{{name}}` is installed (`pf plugin install io-{{name}}`) and registers
 * the adapter: pipes can then use it. `api: 3` is what a plugin that brings IO adapters declares.
 */
export default {
  name: 'io-{{name}}',
  summary: '{{summary}}',
  api: 3,
  commands: [],
  ioAdapters: [adapter],
};
