import type { ClientConfig, QueryResult as PgResult } from 'pg';
import pg from 'pg';
import { makeSession, type ConnectionForm, type ConnectionParams, type DbDriver, type QueryResult } from '@pulpfixer/kit/db';
import type { Plugin } from '@pulpfixer/kit/plugin';

const FORMS: ConnectionForm[] = [
  {
    id: 'params',
    label: 'Host, port, user and password',
    fields: [
      { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
      { key: 'port', label: 'Port', kind: 'number', default: 5432 },
      { key: 'user', label: 'User', kind: 'text', required: true },
      { key: 'password', label: 'Password', kind: 'secret' },
      { key: 'database', label: 'Database', kind: 'text', required: true },
      { key: 'ssl', label: 'Use TLS', kind: 'boolean', default: false, help: 'verifies the server certificate' },
    ],
  },
  {
    id: 'dsn',
    label: 'Connection string (DSN)',
    fields: [{ key: 'dsn', label: 'Connection string', kind: 'secret', required: true, placeholder: 'postgres://user:password@host:5432/database' }],
  },
];

const text = (p: ConnectionParams, k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined);

/** What `pg` is configured with for a form and its values. Exported for tests. */
export function clientConfig(form: string, params: ConnectionParams): ClientConfig {
  if (form === 'dsn') {
    const dsn = text(params, 'dsn');
    if (!dsn) throw new Error('the connection string is empty');
    return { connectionString: dsn };
  }
  const host = text(params, 'host');
  const user = text(params, 'user');
  const database = text(params, 'database');
  if (!host || !user || !database) throw new Error('host, user and database are required');
  const password = text(params, 'password');
  return {
    host,
    port: typeof params.port === 'number' ? params.port : 5432,
    user,
    database,
    ...(password ? { password } : {}),
    ...(params.ssl === true ? { ssl: true } : {}),
  };
}

/** A `pg` result as the common result. Exported for tests. */
export function toResult(res: Pick<PgResult, 'rows' | 'rowCount' | 'command'>): QueryResult {
  const reads = res.command === 'SELECT' || res.command === 'SHOW' || res.command === 'EXPLAIN';
  return {
    rows: res.rows as Record<string, unknown>[],
    ...(!reads && typeof res.rowCount === 'number' ? { affected: res.rowCount } : {}),
  };
}

export const postgresDriver: DbDriver = {
  id: 'postgres',
  label: 'PostgreSQL',
  dialect: 'postgres',
  forms: FORMS,
  describe(form, params) {
    if (form === 'dsn') return 'connection string';
    return `${text(params, 'user') ?? '?'}@${text(params, 'host') ?? '?'}:${typeof params.port === 'number' ? params.port : 5432}/${text(params, 'database') ?? '?'}`;
  },
  async connect(form, params) {
    const client = new pg.Client(clientConfig(form, params));
    await client.connect();
    return makeSession(
      async (q) => toResult(await client.query({ text: q.text, values: q.values })),
      () => client.end(),
    );
  },
};

const plugin: Plugin = {
  name: 'db-postgres',
  api: 2,
  summary: 'PostgreSQL driver for pf db',
  commands: [],
  dbDrivers: [postgresDriver],
};
export default plugin;
