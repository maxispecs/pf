import http from 'node:http';
import https from 'node:https';
import type { Credentials } from './credentials.js';
import { sign } from './sigv4.js';
import { decodeItem, encode, type AttributeValue } from './values.js';

/**
 * A minimal DynamoDB client: the JSON protocol over `node:https` (`X-Amz-Target: DynamoDB_20120810.<Op>`),
 * signed with SigV4. Only what `pf db` needs: PartiQL `ExecuteStatement`, followed through `NextToken`.
 */

export class DynamoError extends Error {
  /** The AWS error name, e.g. `ResourceNotFoundException`. */
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface DynamoConfig {
  region: string;
  /** Override the endpoint (DynamoDB Local, a VPC endpoint). `http:` is only accepted for loopback. */
  endpoint?: string;
  credentials: () => Promise<Credentials>;
  /** Called when AWS says the credentials expired, so the next call resolves new ones. */
  invalidateCredentials?: () => void;
  /** Most items one statement may return (default 10000). More is an error, never a silent cut. */
  maxItems?: number;
  /** Strongly consistent reads (default true). */
  consistentRead?: boolean;
  timeoutMs?: number;
  /** Retries after a throttling answer (default 4). */
  retries?: number;
}

export const DEFAULT_MAX_ITEMS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const THROTTLED = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'ThrottledException']);
const REGION = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export interface Target {
  protocol: 'https:' | 'http:';
  /** Host with the port when it is not the default: what the `host` header holds. */
  host: string;
  hostname: string;
  port: number;
}

const isLoopback = (h: string): boolean => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';

/** Where requests go. Refuses anything that would send credentials in clear text or leak them in the URL. */
export function resolveTarget(region: string, endpoint?: string): Target {
  if (!REGION.test(region)) throw new DynamoError('InvalidRegion', `"${region}" is not a valid AWS region`, 0);
  if (!endpoint) {
    const hostname = `dynamodb.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
    return { protocol: 'https:', host: hostname, hostname, port: 443 };
  }
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new DynamoError('InvalidEndpoint', 'the endpoint is not a valid URL', 0);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DynamoError('InvalidEndpoint', 'the endpoint must be an https:// (or loopback http://) URL', 0);
  if (u.username || u.password) throw new DynamoError('InvalidEndpoint', 'the endpoint must not contain a user or password', 0);
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new DynamoError('InvalidEndpoint', 'the endpoint must be just a scheme, host and port', 0);
  if (u.protocol === 'http:' && !isLoopback(u.hostname)) throw new DynamoError('InvalidEndpoint', 'http:// endpoints are only allowed for localhost (credentials would travel in clear text)', 0);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { protocol: u.protocol, host: u.host, hostname: u.hostname.replace(/^\[|\]$/g, ''), port };
}

function post(t: Target, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const lib = t.protocol === 'https:' ? https : http;
    const req = lib.request({ method: 'POST', hostname: t.hostname, port: t.port, path: '/', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new DynamoError('ResponseTooLarge', 'DynamoDB answered with more than 32 MB', res.statusCode ?? 0));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new DynamoError('Timeout', `DynamoDB did not answer within ${Math.round(timeoutMs / 1000)}s`, 0)));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DynamoClient {
  private readonly target: Target;
  constructor(private readonly cfg: DynamoConfig) {
    this.target = resolveTarget(cfg.region, cfg.endpoint);
  }

  /** One API call. Retries throttling (the request was not processed) and one expired-credentials answer; nothing else. */
  async call<T = Record<string, unknown>>(operation: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    let throttles = 0;
    let refreshed = false;
    for (;;) {
      const creds = await this.cfg.credentials();
      const headers = sign({
        method: 'POST',
        host: this.target.host,
        headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${operation}` },
        body,
        region: this.cfg.region,
        service: 'dynamodb',
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      });
      const res = await post(this.target, headers, body, this.cfg.timeoutMs ?? 30_000);
      if (res.status >= 200 && res.status < 300) return (res.text ? JSON.parse(res.text) : {}) as T;

      const err = toError(res.status, res.text);
      if (THROTTLED.has(err.code) && throttles < (this.cfg.retries ?? 4)) {
        await sleep(50 * 2 ** throttles + Math.random() * 50);
        throttles++;
        continue;
      }
      if ((err.code === 'ExpiredTokenException' || err.code === 'ExpiredToken') && !refreshed && this.cfg.invalidateCredentials) {
        refreshed = true;
        this.cfg.invalidateCredentials();
        continue;
      }
      throw err;
    }
  }

  /**
   * Run one PartiQL statement and every page of its answer. `values` are bound as parameters (`?`).
   * Resolves with the items, decoded to plain values.
   */
  async execute(statement: string, values: readonly unknown[]): Promise<Record<string, unknown>[]> {
    const params: AttributeValue[] = values.map(encode);
    const limit = this.cfg.maxItems ?? DEFAULT_MAX_ITEMS;
    const rows: Record<string, unknown>[] = [];
    let token: string | undefined;
    do {
      const res = await this.call<{ Items?: Record<string, AttributeValue>[]; NextToken?: string }>('ExecuteStatement', {
        Statement: statement,
        ...(params.length ? { Parameters: params } : {}),
        ConsistentRead: this.cfg.consistentRead ?? true,
        ...(token ? { NextToken: token } : {}),
      });
      for (const item of res.Items ?? []) rows.push(decodeItem(item));
      if (rows.length > limit) {
        throw new DynamoError('TooManyItems', `the statement returned more than ${limit} items: narrow it with a key condition, or raise maxItems on the connection`, 200);
      }
      token = res.NextToken;
    } while (token);
    return rows;
  }

  /**
   * Is DynamoDB reachable with these credentials? A `ListTables` of one name. `AccessDeniedException` counts
   * as yes: the request was signed and understood, the policy just does not allow listing (common with
   * policies scoped to some tables). A wrong key, bad signature, expired token or wrong region still fails.
   */
  async ping(): Promise<void> {
    try {
      await this.call('ListTables', { Limit: 1 });
    } catch (e) {
      if (e instanceof DynamoError && e.code === 'AccessDeniedException') return;
      throw e;
    }
  }

  /** Run up to 100 write statements as one all-or-nothing `ExecuteTransaction`. */
  async transact(statements: readonly { text: string; values: readonly unknown[] }[]): Promise<void> {
    if (statements.length === 0) return;
    if (statements.length > 100) throw new DynamoError('TooManyStatements', 'a DynamoDB transaction holds at most 100 statements', 0);
    await this.call('ExecuteTransaction', {
      TransactStatements: statements.map((s) => ({ Statement: s.text, ...(s.values.length ? { Parameters: s.values.map(encode) } : {}) })),
    });
  }
}

function toError(status: number, text: string): DynamoError {
  let code = `HTTP${status}`;
  let message = `DynamoDB answered with HTTP ${status}`;
  try {
    const j = JSON.parse(text) as { __type?: unknown; message?: unknown; Message?: unknown };
    if (typeof j.__type === 'string') code = j.__type.split('#').pop() ?? code;
    const m = j.message ?? j.Message;
    if (typeof m === 'string' && m) message = m;
  } catch {
    // not JSON: keep the generic message (the body may be an HTML error page)
  }
  return new DynamoError(code, `${code}: ${message}`, status);
}
