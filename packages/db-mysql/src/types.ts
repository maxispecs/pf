/**
 * Column definitions, row decoding (text and binary protocol) and parameter encoding. DECIMAL stays a
 * string (money stays exact), BIGINT beyond 2^53 is a string, dates are local-time `Date`s, TIME is a
 * string, JSON is parsed, binary data is a `Buffer`.
 */
import { Reader, Writer } from './packet.js';

export const TYPE = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  NEWDATE: 14,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
} as const;

export const FLAG_UNSIGNED = 32;
const BINARY_CHARSET = 63;

export interface Column {
  name: string;
  charset: number;
  type: number;
  flags: number;
  decimals: number;
}

export function parseColumn(payload: Buffer): Column {
  const r = new Reader(payload);
  r.lenencBytes(); // catalog
  r.lenencBytes(); // schema
  r.lenencBytes(); // table
  r.lenencBytes(); // org_table
  const name = r.lenencString();
  r.lenencBytes(); // org_name
  r.lenenc(); // length of the fixed fields
  const charset = r.u16();
  r.u32(); // column length
  const type = r.u8();
  const flags = r.u16();
  const decimals = r.u8();
  return { name, charset, type, flags, decimals };
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function bigToValue(v: bigint): number | string {
  return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v.toString();
}

/** A local-time Date, or an Invalid Date for MySQL's zero date. */
export function localDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, micros = 0): Date {
  if (y === 0 && mo === 0 && d === 0) return new Date(Number.NaN);
  const date = new Date(2000, 0, 1, h, mi, s, Math.floor(micros / 1000));
  date.setFullYear(y, mo - 1, d);
  return date;
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/;

function parseDateText(s: string): Date {
  const m = DATE_TEXT.exec(s);
  if (!m) return new Date(Number.NaN);
  const micros = m[7] ? Number(m[7].padEnd(6, '0')) : 0;
  return localDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), micros);
}

/** A float32 as the shortest decimal that reads back as the same float32 (what the text protocol prints). */
function float32(v: number): number {
  if (!Number.isFinite(v)) return v;
  for (let p = 1; p <= 9; p++) {
    const n = Number(v.toPrecision(p));
    if (Math.fround(n) === v) return n;
  }
  return v;
}

/** String-like bytes: JSON parsed, binary data and BIT as a Buffer, the rest as UTF-8 text. */
function decodeBytes(col: Column, bytes: Buffer): unknown {
  if (col.type === TYPE.JSON) return JSON.parse(bytes.toString('utf8'));
  if (col.type === TYPE.BIT || col.type === TYPE.GEOMETRY || col.charset === BINARY_CHARSET) return Buffer.from(bytes);
  return bytes.toString('utf8');
}

/** One value of a text-protocol row (`bytes` null is SQL NULL). */
export function decodeText(col: Column, bytes: Buffer | null): unknown {
  if (bytes === null) return null;
  switch (col.type) {
    case TYPE.TINY:
    case TYPE.SHORT:
    case TYPE.LONG:
    case TYPE.INT24:
    case TYPE.YEAR:
    case TYPE.FLOAT:
    case TYPE.DOUBLE:
      return Number(bytes.toString('latin1'));
    case TYPE.LONGLONG:
      return bigToValue(BigInt(bytes.toString('latin1')));
    case TYPE.DECIMAL:
    case TYPE.NEWDECIMAL:
    case TYPE.TIME:
      return bytes.toString('latin1');
    case TYPE.DATE:
    case TYPE.NEWDATE:
    case TYPE.DATETIME:
    case TYPE.TIMESTAMP:
      return parseDateText(bytes.toString('latin1'));
    case TYPE.NULL:
      return null;
    default:
      return decodeBytes(col, bytes);
  }
}

export function decodeTextRow(columns: Column[], payload: Buffer): Record<string, unknown> {
  const r = new Reader(payload);
  const row: Record<string, unknown> = {};
  for (const col of columns) row[col.name] = decodeText(col, r.lenencBytes());
  return row;
}

function formatTime(negative: boolean, hours: number, minutes: number, seconds: number, micros: number, decimals: number): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  let out = `${negative ? '-' : ''}${two(hours)}:${two(minutes)}:${two(seconds)}`;
  const digits = decimals > 0 && decimals <= 6 ? decimals : micros ? 6 : 0;
  if (digits) out += `.${String(micros).padStart(6, '0').slice(0, digits)}`;
  return out;
}

/** One value of a binary-protocol row. */
export function decodeBinary(col: Column, r: Reader): unknown {
  const unsigned = (col.flags & FLAG_UNSIGNED) !== 0;
  switch (col.type) {
    case TYPE.TINY:
      return unsigned ? r.u8() : r.i8();
    case TYPE.SHORT:
    case TYPE.YEAR:
      return unsigned ? r.u16() : r.i16();
    case TYPE.INT24:
    case TYPE.LONG:
      return unsigned ? r.u32() : r.i32();
    case TYPE.LONGLONG:
      return bigToValue(unsigned ? r.u64() : r.i64());
    case TYPE.FLOAT:
      return float32(r.f32());
    case TYPE.DOUBLE:
      return r.f64();
    case TYPE.NULL:
      return null;
    case TYPE.DATE:
    case TYPE.NEWDATE:
    case TYPE.DATETIME:
    case TYPE.TIMESTAMP: {
      const len = r.u8();
      if (len === 0) return localDate(0, 0, 0);
      const y = r.u16();
      const mo = r.u8();
      const d = r.u8();
      const [h, mi, s] = len >= 7 ? [r.u8(), r.u8(), r.u8()] : [0, 0, 0];
      const micros = len >= 11 ? r.u32() : 0;
      return localDate(y, mo, d, h, mi, s, micros);
    }
    case TYPE.TIME: {
      const len = r.u8();
      if (len === 0) return formatTime(false, 0, 0, 0, 0, col.decimals);
      const negative = r.u8() === 1;
      const days = r.u32();
      const h = r.u8();
      const mi = r.u8();
      const s = r.u8();
      const micros = len >= 12 ? r.u32() : 0;
      return formatTime(negative, days * 24 + h, mi, s, micros, col.decimals);
    }
    case TYPE.DECIMAL:
    case TYPE.NEWDECIMAL:
      return r.lenencBytes()!.toString('latin1');
    default:
      return decodeBytes(col, r.lenencBytes()!);
  }
}

export function decodeBinaryRow(columns: Column[], payload: Buffer): Record<string, unknown> {
  const r = new Reader(payload);
  r.u8(); // 0x00 header
  const bitmap = r.bytes((columns.length + 7 + 2) >> 3);
  const row: Record<string, unknown> = {};
  columns.forEach((col, i) => {
    const bit = i + 2;
    row[col.name] = bitmap[bit >> 3]! & (1 << (bit & 7)) ? null : decodeBinary(col, r);
  });
  return row;
}

export interface Param {
  type: number;
  unsigned: boolean;
  /** The encoded value, null for SQL NULL. */
  value: Buffer | null;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

const describe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** One value for COM_STMT_EXECUTE. */
export function encodeParam(v: unknown): Param {
  if (v === null || v === undefined) return { type: TYPE.NULL, unsigned: false, value: null };
  if (typeof v === 'boolean') return { type: TYPE.TINY, unsigned: false, value: Buffer.from([v ? 1 : 0]) };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`MySQL cannot store ${v}`);
    if (Number.isSafeInteger(v)) return { type: TYPE.LONGLONG, unsigned: false, value: new Writer().i64(BigInt(v)).toBuffer() };
    return { type: TYPE.DOUBLE, unsigned: false, value: new Writer().f64(v).toBuffer() };
  }
  if (typeof v === 'bigint') {
    if (v >= INT64_MIN && v <= INT64_MAX) return { type: TYPE.LONGLONG, unsigned: false, value: new Writer().i64(v).toBuffer() };
    if (v > INT64_MAX && v <= UINT64_MAX) return { type: TYPE.LONGLONG, unsigned: true, value: new Writer().u64(v).toBuffer() };
    throw new Error(`${v} does not fit a MySQL BIGINT`);
  }
  if (typeof v === 'string') return { type: TYPE.VAR_STRING, unsigned: false, value: new Writer().lenencString(v).toBuffer() };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new Error('an Invalid Date cannot be a MySQL value');
    const value = new Writer()
      .u8(11)
      .u16(v.getFullYear())
      .u8(v.getMonth() + 1)
      .u8(v.getDate())
      .u8(v.getHours())
      .u8(v.getMinutes())
      .u8(v.getSeconds())
      .u32(v.getMilliseconds() * 1000)
      .toBuffer();
    return { type: TYPE.DATETIME, unsigned: false, value };
  }
  if (v instanceof Uint8Array) return { type: TYPE.BLOB, unsigned: false, value: new Writer().lenencBytes(v).toBuffer() };
  if (typeof v === 'object') return { type: TYPE.VAR_STRING, unsigned: false, value: new Writer().lenencString(JSON.stringify(v)).toBuffer() };
  throw new Error(`MySQL cannot bind a ${describe(v)} value`);
}