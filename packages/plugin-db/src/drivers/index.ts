import type { DbDriver } from '@pulpfixer/kit/db';
import { sqliteDriver } from './sqlite.js';

/** Drivers that ship with pf: no npm dependencies, registered at startup with the built-in plugins. */
export const BUILTIN_DRIVERS: readonly DbDriver[] = [sqliteDriver];

/** Drivers published for pf as plugins, shown by `pf db drivers` when they are not installed. `pf db` installs one when it is needed (`pf db install <id>`). */
export const KNOWN_DRIVERS = [
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL and MariaDB' },
] as const;

export { sqliteDriver };
