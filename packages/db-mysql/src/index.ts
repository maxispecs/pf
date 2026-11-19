import mysql from 'mysql2/promise';
import type { ConnectionOptions } from 'mysql2/promise';
import { makeSession, type ConnectionForm, type ConnectionParams, type DbDriver, type QueryResult } from '@pulpfixer/kit/db';
import type { Plugin } from '@pulpfixer/kit/plugin';

const FORMS: ConnectionForm[] = [
  {
    id: 'params',
    label: 'Host, port, user and password',
    fields: [
      { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
      { key: 'port', label: 'Port', kind: 'number', default: 3306 },
      { key: 'user', label: 'User', kind: 'text', required: true },
      { key: 'password', label: 'Password', kind: 'secret' },
      { key: 'database', label: 'Database', kind: 'text', required: true },
      { key: 'ssl', label: 'Use TLS', kind: 'boolean', default: false, help: 'verifies the server certificate' },
    ],
  },
  {
    id: 'dsn',
    label: 'Connection string (DSN)',
    fields: [{ key: 'dsn', label: 'Connection string', kind: 'secret', required: true, placeholder: 'mysql://user:password@host:3306/database' }],
  },
];

const text = (p: ConnectionParams, k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined);

// DECIMAL stays a string (money stays exact) and BIGINT beyond 2^53 arrives as a string, never rounded.
const COMMON: Partial<ConnectionOptions> = { supportBigNumbers: true, decimalNumbers: false };

/** What `mysql2` is configured with for a form and its values. Exported for tests. */
export function connectionOptions(form: string, params: ConnectionParams): ConnectionOptions {
  if (form === 'dsn') {
    const dsn = text(params, 'dsn');
    if (!dsn) throw new Error('the connection string is empty');
    return { uri: dsn, ...COMMON };
  }
  const host = text(params, 'host');
  const user = text(params, 'user');
  const database = text(params, 'database');
  if (!host || !user || !database) throw new Error('host, user and database are required');
  const password = text(params, 'password');
  return {
    host,
    port: typeof params.port === 'number' ? params.port : 3306,
    user,
    database,
    ...(password ? { password } : {}),
    ...(params.ssl === true ? { ssl: {} } : {}),
    ...COMMON,
  };
}

/** What `connection.query` resolves with (rows, or a header for a write) as the common result. Exported for tests. */
export function toResult(first: unknown): QueryResult {
  if (Array.isArray(first)) return { rows: first as Record<string, unknown>[] };
  const h = (first ?? {}) as { affectedRows?: unknown; insertId?: unknown };
  return {
    rows: [],
    ...(typeof h.affectedRows === 'number' ? { affected: h.affectedRows } : {}),
    ...(typeof h.insertId === 'number' || typeof h.insertId === 'string' ? (h.insertId ? { insertId: h.insertId } : {}) : {}),
  };
}

export const mysqlDriver: DbDriver = {
  id: 'mysql',
  label: 'MySQL and MariaDB',
  dialect: 'mysql',
  forms: FORMS,
  describe(form, params) {
    if (form === 'dsn') return 'connection string';
    return `${text(params, 'user') ?? '?'}@${text(params, 'host') ?? '?'}:${typeof params.port === 'number' ? params.port : 3306}/${text(params, 'database') ?? '?'}`;
  },
  async connect(form, params) {
    const conn = await mysql.createConnection(connectionOptions(form, params));
    return makeSession(
      // query(), not execute(): transaction statements cannot be prepared, and LIMIT ? fails when prepared.
      // mysql2 escapes the values itself.
      async (q) => toResult((await conn.query(q.text, q.values))[0]),
      () => conn.end(),
    );
  },
};

const plugin: Plugin = {
  name: 'db-mysql',
  api: 2,
  summary: 'MySQL and MariaDB driver for pf db',
  commands: [],
  dbDrivers: [mysqlDriver],
};
export default plugin;
