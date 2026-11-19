/**
 * Values in and out, all in the text format. The mapping is the one pf had with node-postgres: int8 and
 * numeric stay strings (exact), int2 / int4 / oid / float4 / float8 are numbers, bool a boolean, json
 * parsed, bytea a `Buffer`, date / timestamp local-time `Date`s and timestamptz an exact `Date`. Arrays of
 * those are arrays; every other type (interval, time, uuid, inet, ...) is its text.
 */
import type { Field } from './protocol.js';

export const OID = {
  BOOL: 16,
  BYTEA: 17,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  OID: 26,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  JSONB: 3802,
} as const;

type Decode = (text: string) => unknown;

const parseBool: Decode = (s) => s === 't' || s === 'true';

const parseJson: Decode = (s) => JSON.parse(s);

/** bytea: hex (`\x0a0b`, the default output) or the old escape format. */
export function parseBytea(s: string): Buffer {
  if (s.startsWith('\\x')) return Buffer.from(s.slice(2), 'hex');
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      out.push(s.charCodeAt(i));
    } else if (s[i + 1] === '\\') {
      out.push(0x5c);
      i += 1;
    } else {
      out.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    }
  }
  return Buffer.from(out);
}

const DATE_TEXT = /^(\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):?(\d{2})?(?::?(\d{2}))?)?( BC)?$/;

/**
 * date, timestamp and timestamptz in DateStyle ISO. Without an offset the time is local; `infinity` is
 * `Infinity`, as node-postgres has it; anything else unreadable is the text.
 */
export function parseDate(s: string): Date | number | string {
  if (s === 'infinity') return Number.POSITIVE_INFINITY;
  if (s === '-infinity') return Number.NEGATIVE_INFINITY;
  const m = DATE_TEXT.exec(s);
  if (!m) return s;
  let year = Number(m[1]);
  if (m[13]) year = 1 - year;
  const [mo, d, h, mi, sec] = [Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  const date = new Date(0);
  if (!m[8] && !m[9]) {
    date.setFullYear(year, mo, d);
    date.setHours(h, mi, sec, ms);
    return date;
  }
  date.setUTCFullYear(year, mo, d);
  date.setUTCHours(h, mi, sec, ms);
  if (m[9]) {
    const offset = (Number(m[10]) * 3600 + Number(m[11] ?? 0) * 60 + Number(m[12] ?? 0)) * 1000;
    date.setTime(date.getTime() - (m[9] === '-' ? -offset : offset));
  }
  return date;
}

/**
 * An array literal (`{1,2,NULL}`, `{"a,b","q\"x"}`, `{{1,2},{3,4}}`, `[0:1]={1,2}`) with each element
 * decoded by `element`. An unquoted NULL is null; a quoted "NULL" is the text.
 */
export function parseArray(s: string, element: Decode): unknown[] {
  let i = 0;
  if (s[0] === '[') i = s.indexOf('=') + 1;
  const fail = (): never => {
    throw new Error('PostgreSQL sent a malformed array');
  };
  const list = (): unknown[] => {
    if (s[i] !== '{') fail();
    i++;
    const out: unknown[] = [];
    if (s[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      if (s[i] === '{') out.push(list());
      else if (s[i] === '"') {
        let v = '';
        for (i++; s[i] !== '"'; i++) {
          if (i >= s.length) fail();
          if (s[i] === '\\') i++;
          v += s[i];
        }
        i++;
        out.push(element(v));
      } else {
        const start = i;
        while (i < s.length && s[i] !== ',' && s[i] !== '}') i++;
        const v = s.slice(start, i);
        out.push(v === 'NULL' ? null : element(v));
      }
      if (s[i] === ',') i++;
      else if (s[i] === '}') {
        i++;
        return out;
      } else fail();
    }
  };
  return list();
}

const asText: Decode = (s) => s;

const SCALARS = new Map<number, Decode>([
  [OID.BOOL, parseBool],
  [OID.BYTEA, parseBytea],
  [OID.INT2, Number],
  [OID.INT4, Number],
  [OID.OID, Number],
  [OID.FLOAT4, Number],
  [OID.FLOAT8, Number],
  [OID.JSON, parseJson],
  [OID.JSONB, parseJson],
  [OID.DATE, parseDate],
  [OID.TIMESTAMP, parseDate],
  [OID.TIMESTAMPTZ, parseDate],
]);

/** Array type OID -> element decoder. Arrays of text-like types are arrays of text. */
const ARRAYS = new Map<number, Decode>([
  [1000, parseBool],
  [1001, parseBytea],
  [1005, Number],
  [1007, Number],
  [1028, Number],
  [1021, Number],
  [1022, Number],
  [199, parseJson],
  [3807, parseJson],
  [1182, parseDate],
  [1115, parseDate],
  [1185, parseDate],
  ...[1002, 1003, 1009, 1014, 1015, 1016, 1231, 2951, 1041, 651, 1040, 1183, 1270, 1187].map((oid): [number, Decode] => [oid, asText]),
]);

/** One value of a result row (`text` null is SQL NULL). */
export function decodeValue(oid: number, text: string | null): unknown {
  if (text === null) return null;
  const scalar = SCALARS.get(oid);
  if (scalar) return scalar(text);
  const element = ARRAYS.get(oid);
  return element ? parseArray(text, element) : text;
}

export function decodeRow(fields: readonly Field[], values: readonly (Buffer | null)[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  fields.forEach((f, i) => {
    const raw = values[i];
    const v = decodeValue(f.typeOid, raw === null || raw === undefined ? null : raw.toString('utf8'));
    if (f.name === '__proto__') Object.defineProperty(row, f.name, { value: v, enumerable: true, writable: true, configurable: true });
    else row[f.name] = v;
  });
  return row;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Local time with its offset, as node-postgres sends a Date: `2024-01-02T03:04:05.006+01:00`. An offset
 * with seconds (local mean time before 1900) keeps them.
 */
export function dateToString(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('an Invalid Date cannot be a PostgreSQL value');
  // getTimezoneOffset() drops the seconds of such an offset, the local fields do not: compare them.
  const fields = new Date(0);
  fields.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  fields.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  const offset = Math.round((fields.getTime() - date.getTime()) / 1000);
  let year = date.getFullYear();
  const bc = year < 1;
  if (bc) year = Math.abs(year) + 1;
  let out = `${pad(year, 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
  const abs = Math.abs(offset);
  out += `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 3600), 2)}:${pad(Math.floor(abs / 60) % 60, 2)}`;
  if (abs % 60) out += `:${pad(abs % 60, 2)}`;
  return bc ? `${out} BC` : out;
}

const byteaHex = (v: Uint8Array): string => `\\x${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}`;

const quoteElement = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A JS array as an array literal; nested arrays are more dimensions. */
export function arrayLiteral(values: readonly unknown[]): string {
  const parts = values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return arrayLiteral(v);
    return quoteElement(paramText(v));
  });
  return `{${parts.join(',')}}`;
}

function paramText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return dateToString(v);
  if (v instanceof Uint8Array) return byteaHex(v);
  if (Array.isArray(v)) return arrayLiteral(v);
  if (typeof v === 'object') return JSON.stringify(v);
  throw new Error(`PostgreSQL cannot bind a ${typeof v} value`);
}

/** One bound value in the text format; null is SQL NULL. */
export function encodeParam(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  return Buffer.from(paramText(v), 'utf8');
}
