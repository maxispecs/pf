/**
 * What to connect to: the `params` form or a `postgres://` connection string, as `PgOptions`. The
 * connection string holds the password, so no error here ever quotes it.
 */
import type { ConnectionParams } from '@pulpfixer/kit/db';

/**
 * - `off`: plain TCP.
 * - `prefer`: TLS when the server offers it, plain TCP when it does not.
 * - `require`: TLS or no connection.
 * Whenever TLS is used, the server certificate is verified against the host name.
 */
export type TlsMode = 'off' | 'prefer' | 'require';

export interface PgOptions {
  host: string;
  port: number;
  /** A Unix socket (`<dir>/.s.PGSQL.<port>`) instead of TCP; `host` is then only a label. */
  socketPath?: string;
  user: string;
  password?: string;
  database: string;
  tls: TlsMode;
  applicationName?: string;
  /** 0 waits for ever. */
  connectTimeoutMs?: number;
}

export const DEFAULT_PORT = 5432;

const SSL_MODES: Record<string, TlsMode> = {
  disable: 'off',
  allow: 'off',
  prefer: 'prefer',
  require: 'require',
  'verify-ca': 'require',
  'verify-full': 'require',
};

const PARAMS = ['sslmode', 'ssl', 'host', 'port', 'application_name', 'connect_timeout'];

const text = (p: ConnectionParams, k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined);

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error(`the connection string has a malformed ${what}`);
  }
}

function port(value: string | number, where: string): number {
  const n = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${where} has an invalid port`);
  return n;
}

/** A host that starts with `/` is the directory of a Unix socket. */
function socketFor(host: string, p: number): string | undefined {
  return host.startsWith('/') ? `${host.replace(/\/+$/, '')}/.s.PGSQL.${p}` : undefined;
}

/**
 * `postgres://user:password@host:port/database?sslmode=require`. The host may be empty (`localhost`), a
 * bracketed IPv6 address or a percent-encoded socket directory, or come from `?host=`. Only the
 * parameters in `PARAMS` are accepted, so a TLS setting pf cannot honor is never dropped silently.
 */
export function parseDsn(dsn: string): PgOptions {
  if (!/^postgres(ql)?:\/\//i.test(dsn)) {
    throw new Error(/^\s*\w+\s*=/.test(dsn)
      ? 'the connection string must be a URL (postgres://user:password@host:5432/database), not key=value pairs'
      : 'the connection string must start with postgres:// or postgresql://');
  }
  // URL refuses credentials without a host (`postgres://u:p@/db?host=/tmp`): give it a placeholder.
  const withHost = dsn.replace(/^(postgres(?:ql)?:\/\/[^/?#]*@)(?=[/?#]|$)/i, '$1localhost');
  let url: URL;
  try {
    url = new URL(withHost);
  } catch {
    throw new Error('the connection string is not a valid URL (postgres://user:password@host:5432/database)');
  }
  let host = decode(url.hostname, 'host').replace(/^\[(.*)\]$/, '$1') || 'localhost';
  let p = url.port ? port(url.port, 'the connection string') : DEFAULT_PORT;
  const user = decode(url.username, 'user');
  if (!user) throw new Error('the connection string has no user');
  const password = url.password ? decode(url.password, 'password') : undefined;
  const database = url.pathname.length > 1 ? decode(url.pathname.slice(1), 'database') : user;
  let tls: TlsMode = 'off';
  let applicationName: string | undefined;
  let connectTimeoutMs: number | undefined;
  for (const [key, value] of url.searchParams) {
    if (key === 'sslmode') {
      const mode = SSL_MODES[value];
      if (!mode) throw new Error(`sslmode in the connection string must be one of ${Object.keys(SSL_MODES).join(', ')}`);
      tls = mode;
    } else if (key === 'ssl') {
      if (!['true', '1', 'false', '0'].includes(value)) throw new Error('ssl in the connection string must be true or false');
      tls = value === 'true' || value === '1' ? 'require' : 'off';
    } else if (key === 'host') {
      if (value) host = value;
    } else if (key === 'port') {
      p = port(value, 'the connection string');
    } else if (key === 'application_name') {
      applicationName = value;
    } else if (key === 'connect_timeout') {
      if (!/^\d+$/.test(value)) throw new Error('connect_timeout in the connection string must be a number of seconds');
      connectTimeoutMs = Number(value) * 1000;
    } else {
      throw new Error(`the connection string has an unsupported parameter "${key}" (supported: ${PARAMS.join(', ')})`);
    }
  }
  const socketPath = socketFor(host, p);
  return {
    host,
    port: p,
    ...(socketPath ? { socketPath } : {}),
    user,
    ...(password ? { password } : {}),
    database,
    tls,
    ...(applicationName ? { applicationName } : {}),
    ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
  };
}

/** The connection options for a form and its values. Exported for tests. */
export function connectionConfig(form: string, params: ConnectionParams): PgOptions {
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
  const p = params.port === undefined ? DEFAULT_PORT : port(params.port as string | number, 'the connection');
  const socketPath = socketFor(host, p);
  return {
    host,
    port: p,
    ...(socketPath ? { socketPath } : {}),
    user,
    ...(password ? { password } : {}),
    database,
    tls: params.ssl === true ? 'require' : 'off',
  };
}
