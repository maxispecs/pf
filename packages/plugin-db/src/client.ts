import { dbDriver, dbDrivers, findForm, type CompiledQuery, type ConnectionParams, type DbDriver, type DbSession, type Dialect, type QueryResult } from '@pulpfixer/kit/db';
import { KNOWN_DRIVERS } from './drivers/index.js';
import { DbError } from './errors.js';
import { resolveSecret } from './secrets.js';
import { getConnection, loadConnections, type Connection } from './store.js';
import { compile, deleteFrom, insert, insertItem, update, type InsertOptions, type Row, type SqlFragment, type SqlLike } from './sql.js';

/**
 * What a write may do on this handle:
 *   allow  run it
 *   deny   throw (the handle is for reading)
 *   dry    pass the statement to `onDryWrite` instead of running it
 * The policy follows the method, not the SQL text: `all`, `one`, `value` and `query` read; `exec`, `insert`,
 * `update` and `deleteFrom` write.
 */
export type WritePolicy = 'allow' | 'deny' | 'dry';

export interface DbOptions {
  writes?: WritePolicy;
  onDryWrite?: (q: CompiledQuery) => void;
}

/** One open database, the same for every driver. Statements are `sql` fragments (or plain strings). */
export interface Db {
  readonly name: string;
  readonly dialect: Dialect;
  /** Run a statement that reads and return the whole result. */
  query(q: SqlLike): Promise<QueryResult>;
  /** Every row. */
  all<T extends Row = Row>(q: SqlLike): Promise<T[]>;
  /** The first row, or undefined. */
  one<T extends Row = Row>(q: SqlLike): Promise<T | undefined>;
  /** The first column of the first row, or undefined. */
  value<T = unknown>(q: SqlLike): Promise<T | undefined>;
  /** Run a statement that changes data. */
  exec(q: SqlLike): Promise<QueryResult>;
  insert(table: string, rows: Row | Row[], opts?: InsertOptions): Promise<QueryResult>;
  /** `where` is required: an object (`{ id: 3 }`) or a `sql` fragment. */
  update(table: string, set: Row, where: Row | SqlFragment): Promise<QueryResult>;
  deleteFrom(table: string, where: Row | SqlFragment): Promise<QueryResult>;
  /** Run `fn` in one transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A `Db` over an open session. Drivers hand sessions to `connect`; tests can use this with a fake one. */
export function makeDb(session: DbSession, dialect: Dialect, name: string, opts: DbOptions = {}): Db {
  const policy = opts.writes ?? 'allow';
  const run = async (q: SqlLike, write: boolean): Promise<QueryResult> => {
    const compiled = compile(q, dialect);
    if (write) {
      if (policy === 'deny') throw new DbError(`this query may only read from "${name}" (it is not marked as writing)`);
      if (policy === 'dry') {
        opts.onDryWrite?.(compiled);
        return { rows: [], affected: 0 };
      }
    }
    return session.execute(compiled);
  };
  const db: Db = {
    name,
    dialect,
    query: (q) => run(q, false),
    all: async <T extends Row>(q: SqlLike) => (await run(q, false)).rows as T[],
    one: async <T extends Row>(q: SqlLike) => (await run(q, false)).rows[0] as T | undefined,
    value: async <T>(q: SqlLike) => {
      const row = (await run(q, false)).rows[0];
      return row ? (Object.values(row)[0] as T | undefined) : undefined;
    },
    exec: (q) => run(q, true),
    insert: (table, rows, o) => run(dialect === 'dynamodb' ? insertItem(table, rows, o) : insert(table, rows, o), true),
    update: (table, set, where) => run(update(table, set, where), true),
    deleteFrom: (table, where) => run(deleteFrom(table, where), true),
    transaction: (fn) => session.transaction((tx) => fn(makeDb(tx, dialect, name, opts))),
    close: () => session.close(),
  };
  return db;
}

/** The driver for a connection, or a `DbError` that names the package to install. */
export function driverFor(id: string): DbDriver {
  const d = dbDriver(id);
  if (d) return d;
  const have = dbDrivers().map((x) => x.id);
  const known = KNOWN_DRIVERS.some((k) => k.id === id);
  throw new DbError(`no database driver "${id}" is installed${have.length ? ` (have: ${have.join(', ')})` : ''}`, known ? `pf db install ${id}` : 'pf db drivers');
}

/** The values a driver is called with: the saved ones plus every secret, read from where it lives. */
export async function resolveParams(name: string, conn: Connection, driver: DbDriver): Promise<ConnectionParams> {
  const form = findForm(driver, conn.form);
  if (!form) throw new DbError(`driver "${driver.id}" has no "${conn.form}" form (connection "${name}")`, `pf db add ${name} --driver ${driver.id}`);
  const params: ConnectionParams = { ...conn.params };
  for (const f of form.fields) {
    if (f.kind !== 'secret') continue;
    const ref = conn.secrets[f.key];
    if (ref) params[f.key] = await resolveSecret(name, f.key, ref);
    else if (f.required) throw new DbError(`connection "${name}" has no ${f.key}`, `pf db add ${name} --driver ${driver.id}`);
  }
  return params;
}

/** Open a saved connection (`pf db add` makes them). Close it when done, or use `withDb`. */
export async function connect(name: string, opts: DbOptions & { driver?: string } = {}): Promise<Db> {
  const conn = getConnection(name);
  if (!conn) {
    const have = Object.keys(loadConnections());
    throw new DbError(`there is no database connection "${name}"${have.length ? ` (have: ${have.join(', ')})` : ''}`, `pf db add ${name}${opts.driver ? ` --driver ${opts.driver}` : ''}`);
  }
  const driver = driverFor(conn.driver);
  const params = await resolveParams(name, conn, driver);
  const session = await driver.connect(conn.form, params);
  return makeDb(session, driver.dialect, name, opts);
}

/** Open a connection from values you hold (a driver id, its form and values), without the saved file. */
export async function connectWith(driverId: string, form: string, params: ConnectionParams, opts: DbOptions & { name?: string } = {}): Promise<Db> {
  const driver = driverFor(driverId);
  const session = await driver.connect(form, params);
  return makeDb(session, driver.dialect, opts.name ?? driverId, opts);
}

/** Open a saved connection, run `fn`, and always close it. */
export async function withDb<T>(name: string, fn: (db: Db) => Promise<T>, opts: DbOptions & { driver?: string } = {}): Promise<T> {
  const db = await connect(name, opts);
  try {
    return await fn(db);
  } finally {
    await db.close().catch(() => undefined);
  }
}
