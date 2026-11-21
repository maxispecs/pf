/**
 * Stream filters: Flate (with PNG / TIFF predictors), ASCIIHex, ASCII85, LZW and RunLength. Image filters
 * (DCT, JBIG2, CCITT, JPX) are reported as unsupported: text extraction never needs them.
 */
import zlib from 'node:zlib';
import { PdfError } from '../errors.js';
import { isDict, Name, type Dict, type PdfObj } from './lexer.js';

export class UnsupportedFilter extends PdfError {
  constructor(readonly filter: string) {
    super(`the stream filter ${filter} is not supported`);
  }
}

const ALIASES: Record<string, string> = { Fl: 'FlateDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', RL: 'RunLengthDecode' };

/** The names of a stream's filters and their parameter dictionaries, in the order they were applied. */
export function filterChain(dict: Dict, resolve: (o: PdfObj) => PdfObj): { name: string; parms: Dict | null }[] {
  const f = resolve(dict.get('Filter') ?? dict.get('F') ?? null);
  const p = resolve(dict.get('DecodeParms') ?? dict.get('DP') ?? null);
  const names = (Array.isArray(f) ? f : f ? [f] : []).map((x) => resolve(x)).filter((x): x is Name => x instanceof Name);
  return names.map((n, i) => {
    const parm = resolve(Array.isArray(p) ? (p[i] ?? null) : i === 0 ? p : null);
    return { name: ALIASES[n.value] ?? n.value, parms: isDict(parm) ? parm : null };
  });
}

export function applyFilters(data: Buffer, dict: Dict, resolve: (o: PdfObj) => PdfObj): Buffer {
  let out = data;
  for (const { name, parms } of filterChain(dict, resolve)) {
    const num = (k: string, d: number): number => {
      const v = parms ? resolve(parms.get(k) ?? null) : null;
      return typeof v === 'number' ? v : d;
    };
    switch (name) {
      case 'FlateDecode':
        out = predictor(inflate(out), num('Predictor', 1), num('Colors', 1), num('BitsPerComponent', 8), num('Columns', 1));
        break;
      case 'LZWDecode':
        out = predictor(lzw(out, num('EarlyChange', 1)), num('Predictor', 1), num('Colors', 1), num('BitsPerComponent', 8), num('Columns', 1));
        break;
      case 'ASCIIHexDecode':
        out = asciiHex(out);
        break;
      case 'ASCII85Decode':
        out = ascii85(out);
        break;
      case 'RunLengthDecode':
        out = runLength(out);
        break;
      case 'Crypt':
        break;
      default:
        throw new UnsupportedFilter(name);
    }
  }
  return out;
}

function inflate(data: Buffer): Buffer {
  try {
    return zlib.inflateSync(data);
  } catch {
    try {
      // a truncated or slightly damaged stream: keep what decodes
      return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      try {
        return zlib.inflateRawSync(data.subarray(2), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch (e) {
        throw new PdfError(`a compressed stream is damaged (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
}

function predictor(data: Buffer, pred: number, colors: number, bpc: number, columns: number): Buffer {
  if (pred <= 1) return data;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (rowBytes <= 0) return data;
  if (pred === 2) {
    if (bpc !== 8) return data;
    const out = Buffer.from(data);
    for (let r = 0; r + rowBytes <= out.length; r += rowBytes) {
      for (let i = colors; i < rowBytes; i++) out[r + i] = (out[r + i]! + out[r + i - colors]!) & 0xff;
    }
    return out;
  }
  const rows = Math.ceil(data.length / (rowBytes + 1));
  const out = Buffer.alloc(rows * rowBytes);
  let prev = Buffer.alloc(rowBytes);
  for (let r = 0; r < rows; r++) {
    const start = r * (rowBytes + 1);
    const type = data[start]!;
    const cur = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    const src = data.subarray(start + 1, start + 1 + rowBytes);
    for (let i = 0; i < src.length; i++) {
      const x = src[i]!;
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v: number;
      switch (type) {
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = x;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

function asciiHex(data: Buffer): Buffer {
  const digits: number[] = [];
  for (const c of data) {
    if (c === 0x3e) break;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v >= 0) digits.push(v);
  }
  if (digits.length % 2) digits.push(0);
  const out = Buffer.alloc(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = digits[2 * i]! * 16 + digits[2 * i + 1]!;
  return out;
}

function ascii85(data: Buffer): Buffer {
  const out: number[] = [];
  let group: number[] = [];
  const flush = (n: number): void => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (group[i] ?? 84);
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n));
  };
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
  for (; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x7e) break;
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      flush(4);
      group = [];
    }
  }
  if (group.length > 1) flush(group.length - 1);
  return Buffer.from(out);
}

function runLength(data: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++]!;
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]!);
    } else {
      const v = data[i++];
      if (v === undefined) break;
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
  }
  return Buffer.from(out);
}

function lzw(data: Buffer, early: number): Buffer {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = (): void => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push([], []); // 256 clear, 257 end
  };
  reset();
  let bits = 9;
  let acc = 0;
  let nacc = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < data.length; ) {
    while (nacc < bits && i < data.length) {
      acc = ((acc << 8) | data[i++]!) >>> 0;
      nacc += 8;
    }
    if (nacc < bits) break;
    const code = (acc >>> (nacc - bits)) & ((1 << bits) - 1);
    nacc -= bits;
    acc &= (1 << nacc) - 1;
    if (code === 256) {
      reset();
      bits = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry: number[];
    if (code < table.length) entry = table[code]!;
    else if (prev) entry = [...prev, prev[0]!];
    else break;
    out.push(...entry);
    if (prev) table.push([...prev, entry[0]!]);
    prev = entry;
    const size = table.length + early;
    bits = size >= 2048 ? 12 : size >= 1024 ? 11 : size >= 512 ? 10 : 9;
  }
  return Buffer.from(out);
}
