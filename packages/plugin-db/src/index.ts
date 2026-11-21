import type { Entry } from '@pulpfixer/kit/types';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { dbCommand } from './commands/db.js';
import { BUILTIN_DRIVERS } from './drivers/index.js';
import { dbAdapter } from './io.js';
import { loadConnections } from './store.js';

export * from './api.js';
export { dbCommand, KNOWN_DRIVERS, parseField, testConnection } from './commands/db.js';
export { BUILTIN_DRIVERS, sqliteDriver } from './drivers/index.js';
export { connectionsPath, loadConnections, getConnection, putConnection, removeConnection, checkName, plainParams, type Connection } from './store.js';
export { parseSecretRef, describeRef, resolveSecret, keychain, setKeychain, keychainAccount, KEYCHAIN_SERVICE, type SecretRef, type Keychain } from './secrets.js';
export { render, toCsv, cellText, rowsOf, type Format } from './output.js';
export { flagName } from './args.js';

/**
 * Database connections and a standard way to query them. `pf db` manages the connections; SQLite is built in
 * (`node:sqlite`), the other drivers (`@pulpfixer/db-postgres`, `db-mysql`) are registry plugins that teach it
 * each database; query packages (`@pulpfixer/query-<name>`) use `defineQueries` and `sql` from `@pulpfixer/plugin-db/api`.
 * Its `db` IO adapter makes a connection an input (a query, streamed) or an output (a table, in one
 * transaction) of a pipe. It has no agent tools: query results can hold user data.
 */
export const dbPlugin: Plugin = {
  name: 'db',
  api: 3,
  summary: 'Database connections and standard queries (SQLite built in, other drivers and query packages are plugins)',
  commands: [dbCommand],
  dbDrivers: [...BUILTIN_DRIVERS],
  ioAdapters: [dbAdapter],
  entries(ctx): Entry[] {
    let detail = 'no connections: pf db add';
    try {
      const n = Object.keys(loadConnections()).length;
      if (n) detail = `${n} connection${n === 1 ? '' : 's'}`;
    } catch {
      detail = 'connections file unreadable';
    }
    return [{ name: 'db', summary: 'Database connections: list, add, remove, test', group: 'Tools', detail, run: () => dbCommand.run(ctx, []) }];
  },
};
