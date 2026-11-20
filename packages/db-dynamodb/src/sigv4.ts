import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for one request, on `node:crypto` only. Written from AWS's "Signing AWS API
 * requests" description; `tests/sigv4.test.ts` checks it against AWS's published test vector.
 */

export interface SignInput {
  method: string;
  host: string;
  /** The URI path, already encoded. DynamoDB always uses `/`. */
  path?: string;
  /** The canonical query string (empty for DynamoDB). */
  query?: string;
  /** Headers to send and sign, besides `host` and `x-amz-date`, which this adds. */
  headers: Record<string, string>;
  body: string | Uint8Array;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}

const sha256hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Uint8Array, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** `20150830T123600Z` */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The derived signing key for one day, region and service. */
export function signingKey(secretAccessKey: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
}

/**
 * The headers to send: the given ones, `host`, `x-amz-date`, `x-amz-security-token` (with a session) and
 * `authorization`. Every header given is signed.
 */
export function sign(input: SignInput): Record<string, string> {
  const date = amzDate(input.now ?? new Date());
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers.host = input.host;
  headers['x-amz-date'] = date;
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [input.method.toUpperCase(), input.path ?? '/', input.query ?? '', canonicalHeaders, signedHeaders, sha256hex(input.body)].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretAccessKey, day, input.region, input.service)).update(toSign).digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
