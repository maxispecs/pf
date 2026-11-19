/**
 * The database driver contract. `@pulpfixer/plugin-db` owns connections and the query helpers; a driver
 * (`@pulpfixer/db-<name>`, a registry plugin) only knows how to open one kind of database and run
 * compiled SQL on it. This file holds the types both sides share and the registry that joins them.
 *
 * Every registry plugin is installed with its own copy of this package, so a module-level variable would
 * not be shared. The registry therefore lives on `globalThis` under a symbol that every copy agrees on.
 */

/** Revision of this contract. A driver written for a newer one is refused by `validateDbDriver`. */
export const DB_API = 1;

export const DIALECTS = ['postgres', 'mysql', 'sqlite'] as const;
export type Dialect = (typeof DIALECTS)[number];

/** One value `pf db add` asks for. A `secret` field is never stored in the connection file. */
export interface ConnectionField {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'path' | 'secret' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
}

/** One way to describe a connection: for example `params` (host, port, ...), `dsn` or `file`. */
export interface ConnectionForm {
  id: string;
  label: string;
  fields: ConnectionField[];
}

/** What a driver receives: the saved values plus the resolved secrets. Never log it. */
export type ConnectionParams = Record<string, string | number | boolean>;

/** SQL with its values separate. `text` uses the dialect's placeholder style (`$1` or `?`). */
export interface CompiledQuery {
  text: string;
  values: unknown[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** Rows changed by an insert, update or delete. */
  affected?: number;
  /** The generated key of the last insert, when the database reports one. */
  insertId?: number | string;
}

/** An open connection. */
export interface DbSession {
  execute(query: CompiledQuery): Promise<QueryResult>;
  /** Run `fn` between BEGIN and COMMIT on one connection (ROLLBACK when it throws). */
  transaction<T>(fn: (tx: DbSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbDriver {
  /** Short name used in `pf db add --driver <id>` and `pulpfixer.json`, e.g. `mysql`. */
  id: string;
  label: string;
  dialect: Dialect;
  /** What can be asked for. The first form is the default. */
  forms: ConnectionForm[];
  /** One safe line for lists, e.g. `app@db.internal:3306/billing`. `params` holds no secrets here. */
  describe(form: string, params: ConnectionParams): string;
  connect(form: string, params: ConnectionParams): Promise<DbSession>;
}

/**
 * A `DbSession` for a driver that can only run statements on one connection: `transaction` is built
 * from BEGIN / COMMIT / ROLLBACK, and a transaction inside one becomes a SAVEPOINT. One connection means
 * one transaction at a time: run them in sequence.
 */
export function makeSession(execute: (q: CompiledQuery) => Promise<QueryResult>, close: () => Promise<void>): DbSession {
  let depth = 0;
  const session: DbSession = {
    execute,
    async transaction<T>(fn: (tx: DbSession) => Promise<T>): Promise<T> {
      const point = `pf_sp_${depth}`;
      const [begin, commit, rollback] =
        depth === 0 ? ['BEGIN', 'COMMIT', 'ROLLBACK'] : [`SAVEPOINT ${point}`, `RELEASE SAVEPOINT ${point}`, `ROLLBACK TO SAVEPOINT ${point}`];
      await execute({ text: begin, values: [] });
      depth++;
      let result: T;
      try {
        result = await fn(session);
      } catch (e) {
        depth--;
        await execute({ text: rollback, values: [] }).catch(() => undefined);
        throw e;
      }
      depth--;
      await execute({ text: commit, values: [] });
      return result;
    },
    close,
  };
  return session;
}

const KEY = Symbol.for('pulpfixer.db.v1');
type Registry = Map<string, DbDriver>;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[KEY] ??= new Map());
}

/** Make drivers known to every copy of the kit. A driver with the same id replaces the earlier one. */
export function registerDbDrivers(drivers: readonly DbDriver[]): void {
  for (const d of drivers) registry().set(d.id, d);
}

export function dbDrivers(): DbDriver[] {
  return [...registry().values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function dbDriver(id: string): DbDriver | undefined {
  return registry().get(id);
}

/** Forget every driver (tests). */
export function clearDbDrivers(): void {
  registry().clear();
}

/**
 * Installs and loads the plugin that carries driver `id` (`@pulpfixer/db-<id>`), registering its drivers.
 * Resolves with why it failed, or null. pf sets it at startup; plugins cannot install plugins themselves.
 */
export type DbDriverInstaller = (id: string) => Promise<string | null>;

const INSTALLER = Symbol.for('pulpfixer.db.installer.v1');

export function setDbDriverInstaller(fn: DbDriverInstaller | null): void {
  const g = globalThis as unknown as Record<symbol, DbDriverInstaller | undefined>;
  if (fn) g[INSTALLER] = fn;
  else delete g[INSTALLER];
}

export function dbDriverInstaller(): DbDriverInstaller | undefined {
  return (globalThis as unknown as Record<symbol, DbDriverInstaller | undefined>)[INSTALLER];
}

const FIELD_KINDS = new Set(['text', 'number', 'path', 'secret', 'boolean']);

/** Check what a plugin exports as a driver. Returns why it is unusable, or null. */
export function validateDbDriver(value: unknown): string | null {
  const d = value as Partial<DbDriver> | null;
  if (!d || typeof d !== 'object') return 'a database driver must be an object';
  if (typeof d.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(d.id)) return 'a database driver needs a lowercase id';
  const at = `driver "${d.id}"`;
  if (!DIALECTS.includes(d.dialect as Dialect)) return `${at} has no valid dialect (${DIALECTS.join(', ')})`;
  if (typeof d.connect !== 'function' || typeof d.describe !== 'function') return `${at} needs connect() and describe()`;
  if (!Array.isArray(d.forms) || d.forms.length === 0) return `${at} has no connection forms`;
  for (const f of d.forms) {
    if (!f || typeof f.id !== 'string' || !Array.isArray(f.fields)) return `${at} has a malformed form`;
    for (const k of f.fields) {
      if (!k || typeof k.key !== 'string' || typeof k.label !== 'string' || !FIELD_KINDS.has(k.kind)) {
        return `${at} form "${f.id}" has a malformed field`;
      }
    }
  }
  return null;
}

export function findForm(driver: DbDriver, id?: string): ConnectionForm | undefined {
  return id ? driver.forms.find((f) => f.id === id) : driver.forms[0];
}
