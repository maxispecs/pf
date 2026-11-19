/**
 * Ed25519 signing for MariaDB's `client_ed25519` plugin. MariaDB hashes the password itself
 * (`SHA512(password)`, any length) where standard Ed25519 hashes a 32-byte seed, so `node:crypto`
 * cannot sign with it; this is the textbook algorithm over BigInt. For a 32-byte password the result
 * is exactly the standard signature with that seed.
 */
import { createHash } from 'node:crypto';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const mod = (a: bigint, m = P): bigint => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);

const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);

/** A point in extended coordinates (X:Y:Z:T), x = X/Z, y = Y/Z, xy = T/Z. */
type Point = readonly [bigint, bigint, bigint, bigint];

const BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
const BASE: Point = [BX, BY, 1n, mod(BX * BY)];
const ZERO: Point = [0n, 1n, 1n, 0n];

function add(p: Point, q: Point): Point {
  const [x1, y1, z1, t1] = p;
  const [x2, y2, z2, t2] = q;
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(t1 * D2 * t2);
  const d = mod(z1 * 2n * z2);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function multiply(p: Point, n: bigint): Point {
  let result = ZERO;
  let addend = p;
  while (n > 0n) {
    if (n & 1n) result = add(result, addend);
    addend = add(addend, addend);
    n >>= 1n;
  }
  return result;
}

function encode(p: Point): Buffer {
  const zi = inv(p[2]);
  const x = mod(p[0] * zi);
  const y = mod(p[1] * zi);
  const out = toLittleEndian(y, 32);
  if (x & 1n) out[31]! |= 0x80;
  return out;
}

function toLittleEndian(n: bigint, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function fromLittleEndian(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

const sha512 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
};

function expand(secret: Uint8Array): { scalar: bigint; prefix: Buffer; publicKey: Buffer } {
  const h = sha512(secret);
  const a = Buffer.from(h.subarray(0, 32));
  a[0]! &= 248;
  a[31]! &= 127;
  a[31]! |= 64;
  const scalar = fromLittleEndian(a);
  return { scalar, prefix: h.subarray(32), publicKey: encode(multiply(BASE, scalar)) };
}

/** The public key MariaDB stores for `secret` (the `authentication_string`, base64 of these 32 bytes). */
export function ed25519PublicKey(secret: Uint8Array): Buffer {
  return expand(secret).publicKey;
}

/** The 64-byte signature of `message` with the key derived from `secret`. */
export function ed25519Sign(message: Uint8Array, secret: Uint8Array): Buffer {
  const { scalar, prefix, publicKey } = expand(secret);
  const r = mod(fromLittleEndian(sha512(prefix, message)), L);
  const R = encode(multiply(BASE, r));
  const k = mod(fromLittleEndian(sha512(R, publicKey, message)), L);
  const s = mod(r + k * scalar, L);
  return Buffer.concat([R, toLittleEndian(s, 32)]);
}
