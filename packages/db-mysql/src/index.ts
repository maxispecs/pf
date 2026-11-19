import { makeSession, type ConnectionForm, type ConnectionParams, type DbDriver } from '@pulpfixer/kit/db';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { Connection, type MysqlOptions } from './connection.js';

export type { MysqlOptions } from './connection.js';

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
    fields: [{ key: 'dsn', label: 'Connection string', kind: 'secret', required: true, placeholder: 'mysql://user:password@host:3306/database?ssl=true' }],
  },
];

const text = (p: ConnectionParams, k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined);

const TLS_MODES: Record<string, boolean> = { DISABLED: false, REQUIRED: true, VERIFY_CA: true, VERIFY_IDENTITY: true };

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error(`the connection string has a malformed ${what}`);
  }
}

/**
 * `mysql://user:password@host:port/database?ssl=true`. Only `ssl` and `ssl-mode` are accepted, so a TLS
 * setting is never dropped silently; every TLS mode verifies the certificate. The string is never quoted
 * in an error: it holds the password.
 */
export function parseDsn(dsn: string): MysqlOptions {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('the connection string is not a valid URL (mysql://user:password@host:3306/database)');
  }
  if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') throw new Error('the connection string must start with mysql:// or mariadb://');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new Error('the connection string has no host');
  const user = decode(url.username, 'user');
  if (!user) throw new Error('the connection string has no user');
  const password = url.password ? decode(url.password, 'password') : undefined;
  const database = url.pathname.length > 1 ? decode(url.pathname.slice(1), 'database') : undefined;
  let tls = false;
  for (const [key, value] of url.searchParams) {
    if (key === 'ssl') {
      if (!['true', '1', 'false', '0'].includes(value)) throw new Error('ssl in the connection string must be true or false');
      tls = value === 'true' || value === '1';
    } else if (key === 'ssl-mode' || key === 'sslmode') {
      const mode = TLS_MODES[value.toUpperCase()];
      if (mode === undefined) throw new Error(`ssl-mode in the connection string must be one of ${Object.keys(TLS_MODES).join(', ')}`);
      tls = mode;
    } else {
      throw new Error(`the connection string has an unsupported parameter "${key}" (supported: ssl, ssl-mode)`);
    }
  }
  return {
    host,
    port: url.port ? Number(url.port) : 3306,
    user,
    ...(password ? { password } : {}),
    ...(database ? { database } : {}),
    tls,
  };
}

/** The connection options for a form and its values. Exported for tests. */
export function connectionOptions(form: string, params: ConnectionParams): MysqlOptions {
  if (form === 'dsn') {
    const dsn = text(params, 'dsn');
    if (!dsn) throw new Error('the connection string is empty');
    return parseDsn(dsn);
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
    tls: params.ssl === true,
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
    const conn = await Connection.open(connectionOptions(form, params));
    return makeSession(
      // Values go as a prepared statement (bound on the server); a statement without values (BEGIN, COMMIT) as text.
      (q) => (q.values.length ? conn.execute(q.text, q.values) : conn.query(q.text)),
      () => conn.close(),
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
