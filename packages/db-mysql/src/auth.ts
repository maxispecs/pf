/**
 * The auth plugins: `mysql_native_password`, `caching_sha2_password` (MySQL 8's default) and MariaDB's
 * `client_ed25519`. Pure: `AuthFlow` turns what the server sends into what the client answers, the
 * connection only moves the bytes. Nothing here logs or keeps the password beyond the flow.
 */
import { constants, createHash, publicEncrypt } from 'node:crypto';
import { ed25519Sign } from './ed25519.js';

export const PLUGINS = ['mysql_native_password', 'caching_sha2_password', 'client_ed25519'] as const;

const hash = (algorithm: string, ...parts: Uint8Array[]): Buffer => {
  const h = createHash(algorithm);
  for (const p of parts) h.update(p);
  return h.digest();
};

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i % b.length]!;
  return out;
}

/** SHA1(password) XOR SHA1(nonce + SHA1(SHA1(password))). */
export function nativePassword(password: string, nonce: Buffer): Buffer {
  if (!password) return Buffer.alloc(0);
  const stage1 = hash('sha1', Buffer.from(password, 'utf8'));
  return xor(stage1, hash('sha1', nonce, hash('sha1', stage1)));
}

/** SHA256(password) XOR SHA256(SHA256(SHA256(password)) + nonce). */
export function cachingSha2Password(password: string, nonce: Buffer): Buffer {
  if (!password) return Buffer.alloc(0);
  const stage1 = hash('sha256', Buffer.from(password, 'utf8'));
  return xor(stage1, hash('sha256', hash('sha256', stage1), nonce));
}

/** The password for caching_sha2's full authentication without TLS: (password + NUL) XOR nonce, RSA-OAEP with the server's key. */
export function rsaPassword(password: string, nonce: Buffer, publicKeyPem: string): Buffer {
  const plain = xor(Buffer.from(`${password}\0`, 'utf8'), nonce);
  return publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING }, plain);
}

const NONCE = 20;
const ED25519_NONCE = 32;

function unsupported(plugin: string): Error {
  return new Error(`the server asks for the "${plugin}" authentication plugin, which pf does not support (supported: ${PLUGINS.join(', ')})`);
}

/** One login's authentication exchange. */
export class AuthFlow {
  private plugin = '';
  private nonce = Buffer.alloc(0);
  private awaitingKey = false;

  constructor(
    private readonly password: string,
    private readonly tls: boolean,
  ) {}

  /** The plugin and data for the handshake response. A plugin pf does not know starts with native and lets the server switch. */
  start(plugin: string, nonce: Buffer): { plugin: string; data: Buffer } {
    const first = plugin === 'caching_sha2_password' ? plugin : 'mysql_native_password';
    return { plugin: first, data: this.respond(first, nonce.subarray(0, NONCE)) };
  }

  /** An AuthSwitchRequest: another plugin and a fresh nonce. */
  switchTo(plugin: string, data: Buffer): Buffer {
    const nonce = data.subarray(0, plugin === 'client_ed25519' ? ED25519_NONCE : NONCE);
    return this.respond(plugin, nonce);
  }

  /** AuthMoreData (0x01 + data). Returns what to send, or null when the server only reports progress. */
  more(data: Buffer): Buffer | null {
    if (this.plugin !== 'caching_sha2_password') throw new Error(`unexpected auth data for the "${this.plugin}" plugin`);
    if (this.awaitingKey) {
      this.awaitingKey = false;
      return rsaPassword(this.password, this.nonce, data.toString('utf8'));
    }
    if (data.length === 1 && data[0] === 0x03) return null;
    if (data.length === 1 && data[0] === 0x04) {
      if (this.tls) return Buffer.from(`${this.password}\0`, 'utf8');
      this.awaitingKey = true;
      return Buffer.from([0x02]);
    }
    throw new Error('unexpected caching_sha2_password auth data');
  }

  private respond(plugin: string, nonce: Buffer): Buffer {
    this.plugin = plugin;
    this.nonce = Buffer.from(nonce);
    this.awaitingKey = false;
    if (plugin === 'mysql_native_password') return nativePassword(this.password, this.nonce);
    if (plugin === 'caching_sha2_password') return cachingSha2Password(this.password, this.nonce);
    if (plugin === 'client_ed25519') {
      if (this.nonce.length !== ED25519_NONCE) throw new Error('client_ed25519: the server sent a short nonce');
      return ed25519Sign(this.nonce, Buffer.from(this.password, 'utf8'));
    }
    throw unsupported(plugin);
  }
}
