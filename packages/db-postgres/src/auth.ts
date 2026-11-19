/**
 * Password authentication: MD5 and SCRAM-SHA-256 (RFC 5802 / RFC 7677, the default since PostgreSQL
 * 14). Pure: the connection moves the bytes. SCRAM proves both ways, so the server's signature is checked
 * before the login counts. No channel binding and no SASLprep, as with node-postgres.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCRAM_SHA_256 = 'SCRAM-SHA-256';

const md5 = (data: string | Buffer): string => createHash('md5').update(data).digest('hex');

/** `md5` + md5(md5(password + user) + salt), in hex. */
export function md5Password(user: string, password: string, salt: Buffer): string {
  return `md5${md5(Buffer.concat([Buffer.from(md5(password + user)), salt]))}`;
}

const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

/** `=` and `,` are escaped in a SCRAM user name. */
const saslName = (s: string): string => s.replace(/=/g, '=3D').replace(/,/g, '=2C');

function attributes(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of message.split(',')) {
    const eq = part.indexOf('=');
    if (eq === 1) out.set(part[0]!, part.slice(2));
  }
  return out;
}

/**
 * One SCRAM-SHA-256 exchange: `first()` is the client-first message, `final(serverFirst)` the
 * client-final message, `verify(serverFinal)` checks the server signature. PostgreSQL ignores the SCRAM
 * user name (it uses the startup user), so it is `*` unless a test vector needs another.
 */
export class ScramClient {
  private readonly firstBare: string;
  private serverSignature: Buffer | null = null;
  private done = false;

  constructor(
    private readonly password: string,
    private readonly nonce = randomBytes(18).toString('base64'),
    user = '*',
  ) {
    this.firstBare = `n=${saslName(user)},r=${nonce}`;
  }

  /** True once the server proved that it knows the password. */
  get verified(): boolean {
    return this.done;
  }

  first(): Buffer {
    return Buffer.from(`n,,${this.firstBare}`, 'utf8');
  }

  final(serverFirst: string): Buffer {
    const a = attributes(serverFirst);
    const nonce = a.get('r');
    const salt = a.get('s');
    const iterations = Number(a.get('i'));
    if (!nonce || !nonce.startsWith(this.nonce) || nonce.length === this.nonce.length) throw new Error('SCRAM: the server sent an invalid nonce');
    if (!salt) throw new Error('SCRAM: the server sent no salt');
    if (!Number.isInteger(iterations) || iterations < 1) throw new Error('SCRAM: the server sent an invalid iteration count');
    const salted = pbkdf2Sync(Buffer.from(this.password, 'utf8'), Buffer.from(salt, 'base64'), iterations, 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const withoutProof = `c=biws,r=${nonce}`;
    const authMessage = `${this.firstBare},${serverFirst},${withoutProof}`;
    const signature = hmac(sha256(clientKey), authMessage);
    const proof = Buffer.alloc(clientKey.length);
    for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i]! ^ signature[i]!;
    this.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
    return Buffer.from(`${withoutProof},p=${proof.toString('base64')}`, 'utf8');
  }

  verify(serverFinal: string): void {
    const a = attributes(serverFinal);
    const error = a.get('e');
    if (error) throw new Error(`SCRAM: the server refused the login (${error})`);
    if (!this.serverSignature) throw new Error('SCRAM: the server finished before the exchange');
    const v = Buffer.from(a.get('v') ?? '', 'base64');
    if (v.length !== this.serverSignature.length || !timingSafeEqual(v, this.serverSignature)) {
      throw new Error('SCRAM: the server signature does not match; it does not know the password');
    }
    this.done = true;
  }
}
