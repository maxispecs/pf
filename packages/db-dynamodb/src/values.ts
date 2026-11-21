/**
 * Plain JS values <-> DynamoDB attribute values (`{ S: 'x' }`, `{ N: '1' }`, ...).
 *
 * Numbers come back as JS numbers when that is exact and as strings when it is not (the way the other
 * pf drivers keep int8 / numeric exact), so a large or precise number is never silently rounded.
 */

export type AttributeValue =
  | { S: string }
  | { N: string }
  | { B: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: AttributeValue[] }
  | { M: Record<string, AttributeValue> }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] };

export class ValueError extends Error {}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

function number(n: number | bigint): { N: string } {
  if (typeof n === 'number' && !Number.isFinite(n)) throw new ValueError('DynamoDB cannot store NaN or Infinity');
  return { N: String(n) };
}

/** A parameter value as DynamoDB takes it. `Set`s become DynamoDB sets (all strings or all numbers). */
export function encode(v: unknown): AttributeValue {
  if (v === null) return { NULL: true };
  switch (typeof v) {
    case 'string':
      return { S: v };
    case 'number':
    case 'bigint':
      return number(v);
    case 'boolean':
      return { BOOL: v };
    case 'undefined':
      throw new ValueError('a value is undefined (use null for NULL)');
    case 'object':
      break;
    default:
      throw new ValueError(`cannot send a ${typeof v} to DynamoDB`);
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new ValueError('an invalid Date cannot be sent');
    return { S: v.toISOString() };
  }
  if (v instanceof Uint8Array) return { B: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return { L: v.map(encode) };
  if (v instanceof Set) {
    const items = [...v];
    if (items.length === 0) throw new ValueError('DynamoDB does not allow an empty set');
    if (items.every((i) => typeof i === 'string')) return { SS: items as string[] };
    if (items.every((i) => typeof i === 'number' || typeof i === 'bigint')) return { NS: items.map((i) => number(i as number | bigint).N) };
    if (items.every((i) => i instanceof Uint8Array)) return { BS: items.map((i) => Buffer.from(i as Uint8Array).toString('base64')) };
    throw new ValueError('a set must hold only strings, only numbers or only binary values');
  }
  if (isPlainObject(v)) {
    const m: Record<string, AttributeValue> = {};
    for (const [k, x] of Object.entries(v)) m[k] = encode(x);
    return { M: m };
  }
  throw new ValueError('cannot send this kind of object to DynamoDB (use a plain object, array, Set, Date or Uint8Array)');
}

/**
 * A DynamoDB number as a JS number when that is exact, else the string: integers must be safe integers,
 * and a decimal must print back as the same digits (so `0.1` is a number and a 20-digit one stays text).
 */
export function decodeNumber(n: string): number | string {
  const x = Number(n);
  if (!Number.isFinite(x)) return n;
  if (/^-?\d+$/.test(n)) return Number.isSafeInteger(x) ? x : n;
  return String(x) === n ? x : n;
}

/** An attribute value as a plain JS value. Binary values are `Buffer`s; sets are arrays. */
export function decode(a: AttributeValue): unknown {
  if ('S' in a) return a.S;
  if ('N' in a) return decodeNumber(a.N);
  if ('BOOL' in a) return a.BOOL;
  if ('NULL' in a) return null;
  if ('B' in a) return Buffer.from(a.B, 'base64');
  if ('L' in a) return a.L.map(decode);
  if ('M' in a) return decodeItem(a.M);
  if ('SS' in a) return [...a.SS];
  if ('NS' in a) return a.NS.map(decodeNumber);
  if ('BS' in a) return a.BS.map((b) => Buffer.from(b, 'base64'));
  throw new ValueError(`unknown DynamoDB attribute type: ${Object.keys(a).join(', ')}`);
}

export function decodeItem(item: Record<string, AttributeValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) out[k] = decode(v);
  return out;
}
