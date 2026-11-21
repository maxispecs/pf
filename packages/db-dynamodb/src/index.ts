import type { CompiledQuery, ConnectionField, ConnectionForm, ConnectionParams, DbDriver, DbSession, QueryResult } from '@pulpfixer/kit/db';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { DEFAULT_MAX_ITEMS, DynamoClient, DynamoError, resolveTarget, type DynamoConfig } from './client.js';
import { cachedCredentials, CredentialsError, type CredentialSource } from './credentials.js';

export { DynamoClient, DynamoError, resolveTarget, type DynamoConfig } from './client.js';
export { cachedCredentials, CredentialsError, parseExported, parseIni, resolveCredentials, type Credentials, type CredentialSource } from './credentials.js';
export { sign, signingKey, type SignInput } from './sigv4.js';
export { decode, decodeItem, encode, ValueError, type AttributeValue } from './values.js';

const region: ConnectionField = { key: 'region', label: 'AWS region', kind: 'text', required: true, placeholder: 'eu-west-1' };
const endpoint: ConnectionField = {
  key: 'endpoint',
  label: 'Endpoint',
  kind: 'text',
  placeholder: 'http://localhost:8000',
  help: 'leave empty for AWS; DynamoDB Local or a VPC endpoint otherwise (http:// only for localhost)',
};
const maxItems: ConnectionField = {
  key: 'maxItems',
  label: 'Most items per statement',
  kind: 'number',
  default: DEFAULT_MAX_ITEMS,
  help: 'a statement that returns more fails instead of being cut short',
};
const consistent: ConnectionField = { key: 'consistentRead', label: 'Strongly consistent reads', kind: 'boolean', default: true, help: 'costs twice the read capacity of eventually consistent reads' };

const FORMS: ConnectionForm[] = [
  {
    id: 'profile',
    label: 'AWS profile or environment credentials',
    fields: [
      region,
      { key: 'profile', label: 'AWS profile', kind: 'text', help: 'a profile in ~/.aws (SSO and assume-role work through the aws CLI); empty uses AWS_* variables (AWS_SESSION_TOKEN too), then the default profile' },
      endpoint,
      maxItems,
      consistent,
    ],
  },
  {
    id: 'keys',
    label: 'Access key',
    fields: [
      region,
      { key: 'accessKeyId', label: 'Access key id', kind: 'text', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', kind: 'secret', required: true },
      endpoint,
      maxItems,
      consistent,
    ],
  },
];

const text = (p: ConnectionParams, k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined);

const isRead = (statement: string): boolean => /^\s*SELECT\b/i.test(statement);
const verb = (statement: string): string => /^\s*([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase() ?? '';

/** Build the client for a connection. Exported for tests. */
export function clientFor(form: string, params: ConnectionParams): DynamoClient {
  const reg = text(params, 'region');
  if (!reg) throw new DynamoError('InvalidRegion', 'the connection has no region', 0);
  const src: CredentialSource =
    form === 'keys'
      ? (() => {
          const accessKeyId = text(params, 'accessKeyId');
          const secretAccessKey = text(params, 'secretAccessKey');
          if (!accessKeyId || !secretAccessKey) throw new CredentialsError('the connection needs an access key id and secret access key');
          return { keys: { accessKeyId, secretAccessKey } };
        })()
      : { ...(text(params, 'profile') ? { profile: text(params, 'profile')! } : {}) };
  const creds = cachedCredentials(src);
  const max = typeof params.maxItems === 'number' && params.maxItems > 0 ? Math.floor(params.maxItems) : undefined;
  const cfg: DynamoConfig = {
    region: reg,
    credentials: () => creds.get(),
    invalidateCredentials: () => creds.invalidate(),
    ...(text(params, 'endpoint') ? { endpoint: text(params, 'endpoint')! } : {}),
    ...(max ? { maxItems: max } : {}),
    ...(params.consistentRead === false ? { consistentRead: false } : {}),
  };
  return new DynamoClient(cfg);
}

/**
 * A session over one client. PartiQL statements change one item each (insert, update and delete name a
 * full primary key), so a success is one changed item, except for DELETE, which succeeds on a missing
 * item and reports only what `RETURNING` gives back.
 *
 * DynamoDB has no interactive transactions. `transaction()` queues the writes `fn` makes and sends them
 * as one all-or-nothing `ExecuteTransaction` (at most 100) when `fn` returns; a read inside it is an error.
 */
export function makeDynamoSession(client: DynamoClient): DbSession {
  const run = async (q: CompiledQuery): Promise<QueryResult> => {
    // `pf db test` / `pf db add` check a connection with `SELECT 1`, which PartiQL does not accept.
    if (q.values.length === 0 && /^\s*SELECT\s+1\s*;?\s*$/i.test(q.text)) {
      await client.ping();
      return { rows: [{ '1': 1 }] };
    }
    const rows = await client.execute(q.text, q.values);
    if (isRead(q.text)) return { rows };
    const v = verb(q.text);
    if (v === 'INSERT' || v === 'UPDATE') return { rows, affected: 1 };
    if (v === 'DELETE' && rows.length > 0) return { rows, affected: rows.length };
    return { rows };
  };
  const session = (queue?: CompiledQuery[]): DbSession => ({
    async execute(q) {
      if (!queue) return run(q);
      if (isRead(q.text)) throw new DynamoError('ReadInTransaction', 'a DynamoDB transaction can only hold writes: read before or after it', 0);
      queue.push(q);
      return { rows: [] };
    },
    async transaction<T>(fn: (tx: DbSession) => Promise<T>): Promise<T> {
      if (queue) return fn(session(queue));
      const q: CompiledQuery[] = [];
      const result = await fn(session(q));
      await client.transact(q);
      return result;
    },
    async close() {},
  });
  return session();
}

export const dynamodbDriver: DbDriver = {
  id: 'dynamodb',
  label: 'Amazon DynamoDB (PartiQL)',
  dialect: 'dynamodb',
  forms: FORMS,
  describe(form, params) {
    const where = text(params, 'endpoint') ? ` at ${resolveTargetHost(params)}` : '';
    const who = form === 'keys' ? 'access key' : text(params, 'profile') ? `profile ${text(params, 'profile')}` : 'environment credentials';
    return `dynamodb ${text(params, 'region') ?? '?'}${where} (${who})`;
  },
  async connect(form, params) {
    return makeDynamoSession(clientFor(form, params));
  },
};

/** The host of a configured endpoint, for `describe` (never its credentials: they are refused). */
function resolveTargetHost(params: ConnectionParams): string {
  try {
    return resolveTarget(text(params, 'region') ?? '', text(params, 'endpoint')).host;
  } catch {
    return 'an invalid endpoint';
  }
}

const plugin: Plugin = {
  name: 'db-dynamodb',
  api: 2,
  summary: 'Amazon DynamoDB driver for pf db',
  commands: [],
  dbDrivers: [dynamodbDriver],
};
export default plugin;
