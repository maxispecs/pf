import { makeSession, type ConnectionForm, type ConnectionParams, type DbDriver, type QueryResult } from '@pulpfixer/kit/db';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { connectionConfig, DEFAULT_PORT } from './config.js';
import { PgConnection, type PgResult } from './connection.js';

export { connectionConfig, parseDsn, type PgOptions, type TlsMode } from './config.js';
export { PostgresError } from './protocol.js';

const FORMS: ConnectionForm[] = [
  {
    id: 'params',
    label: 'Host, port, user and password',
    fields: [
      { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
      { key: 'port', label: 'Port', kind: 'number', default: DEFAULT_PORT },
      { key: 'user', label: 'User', kind: 'text', required: true },
      { key: 'password', label: 'Password', kind: 'secret' },
      { key: 'database', label: 'Database', kind: 'text', required: true },
      { key: 'ssl', label: 'Use TLS', kind: 'boolean', default: false, help: 'verifies the server certificate' },
    ],
  },
  {
    id: 'dsn',
    label: 'Connection string (DSN)',
    fields: [{ key: 'dsn', label: 'Connection string', kind: 'secret', required: true, placeholder: 'postgres://user:password@host:5432/database?sslmode=require' }],
  },
];

const text = (p: ConnectionParams, k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined);

const READS = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'FETCH', 'MOVE']);

/** A statement's result as the common result. Exported for tests. */
export function toResult(res: Pick<PgResult, 'rows' | 'rowCount' | 'command'>): QueryResult {
  return {
    rows: res.rows,
    ...(!READS.has(res.command) && typeof res.rowCount === 'number' ? { affected: res.rowCount } : {}),
  };
}

export const postgresDriver: DbDriver = {
  id: 'postgres',
  label: 'PostgreSQL',
  dialect: 'postgres',
  forms: FORMS,
  describe(form, params) {
    if (form === 'dsn') return 'connection string';
    return `${text(params, 'user') ?? '?'}@${text(params, 'host') ?? '?'}:${typeof params.port === 'number' ? params.port : DEFAULT_PORT}/${text(params, 'database') ?? '?'}`;
  },
  async connect(form, params) {
    const conn = await PgConnection.open(connectionConfig(form, params));
    const session = makeSession(
      async (q) => toResult(await conn.query(q.text, q.values)),
      () => conn.close(),
    );
    session.stream = (q, batchSize) => conn.stream(q.text, q.values, batchSize);
    return session;
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
