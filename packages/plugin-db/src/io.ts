import { ioRef, type IoAdapter, type IoRef } from '@pulpfixer/kit/io';
import { connect, type Db } from './client.js';
import { DbError } from './errors.js';
import type { Row, SqlLike } from './sql.js';

/** Read rows: the result of a statement that reads. */
export interface DbSourceConfig {
  /** The saved connection (`pf db add`). */
  connection: string;
  /** A `sql` fragment (or a plain statement). It may only read. */
  query: SqlLike;
  /** The driver `pf db add` suggests when the connection is missing. */
  driver?: string;
}

interface DbSinkBase {
  connection: string;
  driver?: string;
}

/** Write rows into a table with batched inserts. */
export interface DbTableSinkConfig extends DbSinkBase {
  table: string;
}

/** Write rows your own way (an upsert, an update, several tables). `db` is the transaction; every batch calls it. */
export interface DbWriteSinkConfig extends DbSinkBase {
  write(db: Db, rows: Row[]): unknown;
}

export type DbSinkConfig = DbTableSinkConfig | DbWriteSinkConfig;
export type DbConfig = DbSourceConfig | DbSinkConfig;

/** A statement may bind at most this many values (drivers differ; the lowest is SQLite's 32766). */
export const MAX_INSERT_VALUES = 30000;

/**
 * Cut a batch into the groups one INSERT can take: consecutive rows with the same columns, and no more
 * values than a statement may bind.
 */
export function insertChunks(rows: readonly Row[]): Row[][] {
  const out: Row[][] = [];
  let cur: Row[] = [];
  let signature = '';
  for (const r of rows) {
    const keys = Object.keys(r);
    const sig = [...keys].sort().join('\0');
    const limit = Math.max(1, Math.floor(MAX_INSERT_VALUES / Math.max(1, keys.length)));
    if (cur.length > 0 && (sig !== signature || cur.length >= limit)) {
      out.push(cur);
      cur = [];
    }
    signature = sig;
    cur.push(r);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const isSink = (c: DbConfig): c is DbSinkConfig => 'table' in c || 'write' in c;

function check(config: unknown, role: 'source' | 'sink'): DbConfig {
  const c = config as Partial<DbSourceConfig & DbTableSinkConfig & DbWriteSinkConfig> | null;
  if (!c || typeof c !== 'object') throw new DbError('the db adapter needs a configuration object');
  if (typeof c.connection !== 'string' || c.connection === '') throw new DbError('the db adapter needs a connection name (see pf db)');
  if (c.driver !== undefined && typeof c.driver !== 'string') throw new DbError('driver must be a driver id such as "postgres"');
  if (role === 'source') {
    if (c.query === undefined || c.query === null) throw new DbError('a db source needs a query (a sql fragment)');
  } else if (typeof c.table === 'string') {
    if (c.table === '') throw new DbError('a db sink needs a table name');
  } else if (typeof c.write !== 'function') {
    throw new DbError('a db sink needs a table (rows are inserted) or a write(db, rows) function');
  }
  return c as DbConfig;
}

/** A thrown inside a transaction to roll it back. */
class Rollback extends Error {}

const valuesText = (values: unknown[]): string => (values.length ? `   ${JSON.stringify(values, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}` : '');

/**
 * The database as rows to read and a place to write them. A source streams the result of a query in
 * batches (a driver that can fetch in pieces never holds the whole table). A sink runs inside one
 * transaction: everything is committed when the pipe has worked and rolled back when it has not. Under
 * `--dry-run` a sink writes nothing, it reports what it would do.
 */
export const dbAdapter: IoAdapter<DbConfig> = {
  id: 'db',
  label: 'Database (a pf db connection)',
  describe(config) {
    const c = config as Partial<DbSourceConfig & DbTableSinkConfig & DbWriteSinkConfig> | null;
    const name = typeof c?.connection === 'string' ? c.connection : '?';
    if (typeof c?.table === 'string') return `database "${name}", table ${c.table}`;
    if (typeof c?.write === 'function') return `database "${name}" (custom write)`;
    return `database "${name}" (query)`;
  },
  async source(config, io) {
    const c = check(config, 'source') as DbSourceConfig;
    const db = await connect(c.connection, { writes: 'deny', ...(c.driver ? { driver: c.driver } : {}) });
    return {
      batches: () => db.stream(c.query, io.batchSize),
      close: () => db.close(),
    };
  },
  async sink(config, io) {
    const c = check(config, 'sink');
    if (!isSink(c)) throw new DbError('a db sink needs a table or a write function');
    const byTable = 'table' in c;
    let inserted = 0;
    const db = await connect(c.connection, {
      writes: io.dryRun ? 'dry' : 'allow',
      // A table sink says how many rows it would insert at the end; a custom one shows each statement.
      onDryWrite: (q) => {
        if (!byTable) io.log(`would run ${q.text}${valuesText(q.values)}`);
      },
      ...(c.driver ? { driver: c.driver } : {}),
    });

    // The transaction is a callback on a Db; it is held open here until close() says commit or roll back.
    let tx: Db = db;
    const held: { finish: ((ok: boolean) => Promise<void>) | null } = { finish: null };
    if (!io.dryRun) {
      try {
        let decide: (ok: boolean) => void = () => undefined;
        const decision = new Promise<boolean>((resolve) => (decide = resolve));
        tx = await new Promise<Db>((resolve, reject) => {
          const done = db.transaction(async (t) => {
            resolve(t);
            if (!(await decision)) throw new Rollback();
          });
          done.catch(reject);
          held.finish = async (ok) => {
            decide(ok);
            await done.catch((e: unknown) => {
              if (!(e instanceof Rollback)) throw e;
            });
          };
        });
      } catch (e) {
        await db.close().catch(() => undefined);
        throw e;
      }
    }

    return {
      async write(batch) {
        if (batch.length === 0) return;
        if (byTable) {
          for (const chunk of insertChunks(batch)) await tx.insert(c.table, chunk);
          inserted += batch.length;
        } else {
          await c.write(tx, batch);
        }
      },
      async close(ok) {
        try {
          if (held.finish) await held.finish(ok);
          else if (io.dryRun && byTable) io.log(`would insert ${inserted} row${inserted === 1 ? '' : 's'} into ${c.table}`);
        } finally {
          await db.close().catch(() => undefined);
        }
      },
    };
  },
};

/** An input that reads the result of `query` on a saved connection. */
export const dbSource = (config: DbSourceConfig): IoRef<DbSourceConfig> => ioRef('db', config);

/** An output that inserts into `table`, or hands each batch to `write(db, rows)`, inside one transaction. */
export function dbSink(config: DbTableSinkConfig): IoRef<DbTableSinkConfig>;
export function dbSink(config: DbWriteSinkConfig): IoRef<DbWriteSinkConfig>;
export function dbSink(config: DbSinkConfig): IoRef<DbSinkConfig> {
  return ioRef('db', config);
}
