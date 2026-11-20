/**
 * A tiny DynamoDB for tests: an http server on loopback that checks every request's SigV4 signature (its
 * own derivation, not the client's code) and answers each operation from a handler.
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  operation: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  /** True when the signature verified against the secret the server was given. */
  signatureOk: boolean;
}

export type Answer = { status?: number; json: unknown };
export type Handler = (seen: Seen, count: number) => Answer;

export interface FakeDynamo {
  endpoint: string;
  seen: Seen[];
  close(): Promise<void>;
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const mac = (k: string | Buffer, d: string): Buffer => createHmac('sha256', k).update(d).digest();

function verify(req: http.IncomingMessage, body: string, secret: string): boolean {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  const [, , day, region, service, signed, signature] = m;
  const canonical = [
    req.method,
    '/',
    '',
    ...signed!.split(';').map((h) => `${h}:${String(req.headers[h]).trim()}`),
    '',
    signed,
    sha(body),
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${day}/${region}/${service}/aws4_request`, sha(canonical)].join('\n');
  const key = mac(mac(mac(mac(`AWS4${secret}`, day!), region!), service!), 'aws4_request');
  return mac(key, toSign).toString('hex') === signature;
}

export async function fakeDynamo(handler: Handler, secret = 'test-secret'): Promise<FakeDynamo> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        operation: String(req.headers['x-amz-target']).replace('DynamoDB_20120810.', ''),
        body: JSON.parse(body || '{}') as Record<string, unknown>,
        headers: req.headers,
        signatureOk: verify(req, body, secret),
      };
      seen.push(entry);
      const a = handler(entry, seen.length);
      res.writeHead(a.status ?? 200, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify(a.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

export const err = (type: string, message: string, status = 400): Answer => ({ status, json: { __type: `com.amazonaws.dynamodb.v20120810#${type}`, message } });
