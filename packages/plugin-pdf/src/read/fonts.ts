/**
 * Decoding text in PDF fonts: codes to Unicode (base encodings, `/Differences`, ToUnicode CMaps, Type0 fonts)
 * and the glyph widths the layout needs. Fonts are never rendered, only decoded.
 */
import { baseEncoding, glyphToUnicode, type BaseEncoding } from '../encodings.js';
import { charWidth, parseFont } from '../metrics.js';
import type { PdfDocument } from './document.js';
import { isDict, Lexer, Name, Op, PdfString, Stream, type Dict, type PdfObj } from './lexer.js';

export interface Glyph {
  text: string;
  /** In 1/1000 text space units (an em is 1000). */
  width: number;
  /** A single-byte code 32: word spacing applies. */
  space: boolean;
}

export class PdfFont {
  constructor(readonly name: string, private readonly decode: (bytes: Buffer) => Glyph[]) {}
  glyphs(bytes: Buffer): Glyph[] {
    return this.decode(bytes);
  }
}

// -- CMaps ---------------------------------------------------------------------------------------------------

export interface CMap {
  spaces: { lo: number; hi: number; len: number }[];
  map: Map<number, string>;
}

const num = (b: Buffer): number => b.reduce((a, x) => a * 256 + x, 0);

function utf16(b: Buffer): string {
  if (b.length === 1) return String.fromCharCode(b[0]!);
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  return s;
}

function bump(s: string, by: number): string {
  if (by === 0 || s === '') return s;
  return s.slice(0, -1) + String.fromCharCode(s.charCodeAt(s.length - 1) + by);
}

/** Read the code space ranges and the code to text mappings of a CMap (a ToUnicode map or an embedded encoding). */
export function parseCMap(data: Buffer): CMap {
  const cmap: CMap = { spaces: [], map: new Map() };
  const lx = new Lexer(data, 0, false);
  let mode: 'space' | 'char' | 'range' | null = null;
  let items: PdfObj[] = [];
  const text = (o: PdfObj | undefined): string => (o instanceof PdfString ? utf16(o.bytes) : o instanceof Name ? glyphToUnicode(o.value) : '');
  try {
    while (!lx.atEnd()) {
      const o = lx.next();
      if (!(o instanceof Op)) {
        if (mode) items.push(o);
        continue;
      }
      switch (o.op) {
        case 'begincodespacerange': mode = 'space'; items = []; break;
        case 'beginbfchar': mode = 'char'; items = []; break;
        case 'beginbfrange': mode = 'range'; items = []; break;
        case 'endcodespacerange':
          for (let i = 0; i + 1 < items.length; i += 2) {
            const lo = items[i];
            const hi = items[i + 1];
            if (lo instanceof PdfString && hi instanceof PdfString) cmap.spaces.push({ lo: num(lo.bytes), hi: num(hi.bytes), len: lo.bytes.length });
          }
          mode = null;
          break;
        case 'endbfchar':
          for (let i = 0; i + 1 < items.length; i += 2) {
            const src = items[i];
            if (src instanceof PdfString) cmap.map.set(num(src.bytes), text(items[i + 1]));
          }
          mode = null;
          break;
        case 'endbfrange':
          for (let i = 0; i + 2 < items.length; i += 3) {
            const lo = items[i];
            const hi = items[i + 1];
            const dst = items[i + 2];
            if (!(lo instanceof PdfString) || !(hi instanceof PdfString)) continue;
            const a = num(lo.bytes);
            const z = num(hi.bytes);
            if (z < a || z - a > 65535) continue;
            if (Array.isArray(dst)) for (let k = 0; k <= z - a && k < dst.length; k++) cmap.map.set(a + k, text(dst[k]));
            else {
              const base = text(dst);
              for (let k = 0; k <= z - a; k++) cmap.map.set(a + k, bump(base, k));
            }
          }
          mode = null;
          break;
        default:
          break;
      }
    }
  } catch {
    // a CMap that stops making sense keeps what was read
  }
  return cmap;
}

// -- fonts ---------------------------------------------------------------------------------------------------

const BASE_NAMES: Record<string, BaseEncoding> = {
  WinAnsiEncoding: 'WinAnsiEncoding',
  MacRomanEncoding: 'MacRomanEncoding',
  StandardEncoding: 'StandardEncoding',
  MacExpertEncoding: 'StandardEncoding',
  PDFDocEncoding: 'PDFDocEncoding',
};

const stripSubset = (n: string): string => n.replace(/^[A-Z]{6}\+/, '');

function numbers(doc: PdfDocument, arr: PdfObj[] | null): number[] {
  return (arr ?? []).map((x) => {
    const v = doc.resolve(x);
    return typeof v === 'number' ? v : 0;
  });
}

export function loadFont(doc: PdfDocument, dict: Dict): PdfFont {
  const subtype = doc.getName(dict, 'Subtype');
  const baseFont = stripSubset(doc.getName(dict, 'BaseFont') ?? '');
  const toUni = doc.get(dict, 'ToUnicode');
  const uni = toUni instanceof Stream ? parseCMap(doc.streamData(toUni)) : null;
  return subtype === 'Type0' ? composite(doc, dict, baseFont, uni) : simple(doc, dict, subtype, baseFont, uni);
}

function composite(doc: PdfDocument, dict: Dict, name: string, uni: CMap | null): PdfFont {
  const enc = doc.get(dict, 'Encoding');
  const encMap = enc instanceof Stream ? parseCMap(doc.streamData(enc)) : null;
  const spaces = encMap?.spaces.length ? encMap.spaces : uni?.spaces.length ? uni.spaces : [];
  const descendants = doc.getArray(dict, 'DescendantFonts');
  const desc = descendants?.[0] ? doc.resolve(descendants[0]) : null;
  const widths = new Map<number, number>();
  let dw = 1000;
  if (isDict(desc)) {
    dw = doc.getNumber(desc, 'DW') ?? 1000;
    const w = doc.getArray(desc, 'W') ?? [];
    for (let i = 0; i < w.length; ) {
      const first = doc.resolve(w[i]);
      const second = doc.resolve(w[i + 1]);
      if (typeof first !== 'number') break;
      if (Array.isArray(second)) {
        numbers(doc, second).forEach((v, k) => widths.set(first + k, v));
        i += 2;
      } else if (typeof second === 'number') {
        const v = doc.resolve(w[i + 2]);
        if (typeof v === 'number' && second - first < 70000) for (let c = first; c <= second; c++) widths.set(c, v);
        i += 3;
      } else break;
    }
  }
  return new PdfFont(name, (bytes) => {
    const out: Glyph[] = [];
    for (let i = 0; i < bytes.length; ) {
      let len = 0;
      let code = 0;
      if (spaces.length) {
        for (let l = 1; l <= 4 && i + l <= bytes.length; l++) {
          const c = num(bytes.subarray(i, i + l));
          if (spaces.some((s) => s.len === l && c >= s.lo && c <= s.hi)) {
            len = l;
            code = c;
            break;
          }
        }
        if (!len) {
          len = Math.min(spaces[0]!.len, bytes.length - i);
          code = num(bytes.subarray(i, i + len));
        }
      } else {
        len = Math.min(2, bytes.length - i);
        code = num(bytes.subarray(i, i + len));
      }
      out.push({ text: uni?.map.get(code) ?? '\ufffd', width: widths.get(code) ?? dw, space: len === 1 && code === 32 });
      i += len;
    }
    return out;
  });
}

function simple(doc: PdfDocument, dict: Dict, subtype: string | null, name: string, uni: CMap | null): PdfFont {
  // code -> text
  const symbolic = /^(Symbol|ZapfDingbats)/.test(name);
  const enc = doc.get(dict, 'Encoding');
  let base: BaseEncoding | null = null;
  let diffs: PdfObj[] = [];
  if (enc instanceof Name) base = BASE_NAMES[enc.value] ?? null;
  else if (isDict(enc)) {
    const b = doc.getName(enc, 'BaseEncoding');
    base = b ? (BASE_NAMES[b] ?? null) : null;
    diffs = doc.getArray(enc, 'Differences') ?? [];
  }
  const table = symbolic && !base ? new Array<string>(256).fill('') : baseEncoding(base ?? (subtype === 'TrueType' ? 'WinAnsiEncoding' : 'StandardEncoding'));
  let code = 0;
  for (const d of diffs) {
    const v = doc.resolve(d);
    if (typeof v === 'number') code = v;
    else if (v instanceof Name) {
      if (code >= 0 && code < 256) table[code] = glyphToUnicode(v.value);
      code++;
    }
  }

  // widths
  const first = doc.getNumber(dict, 'FirstChar') ?? 0;
  const list = numbers(doc, doc.getArray(dict, 'Widths'));
  const descriptor = doc.getDict(dict, 'FontDescriptor');
  const missing = descriptor ? (doc.getNumber(descriptor, 'MissingWidth') ?? 0) : 0;
  const std = parseFont(name);
  const matrix = doc.getArray(dict, 'FontMatrix');
  const scale = subtype === 'Type3' ? (typeof matrix?.[0] === 'number' ? matrix[0] * 1000 : 1) : 1;
  const widthOf = (c: number): number => {
    const i = c - first;
    if (i >= 0 && i < list.length) return list[i]! * scale;
    if (list.length === 0 && std && table[c]) return charWidth(std, table[c]!);
    return missing || (list.length === 0 && std ? 556 : 500);
  };

  return new PdfFont(name, (bytes) => {
    const out: Glyph[] = [];
    for (const c of bytes) {
      const mapped = uni?.map.get(c);
      let text = mapped ?? table[c] ?? '';
      if (text === '' && mapped === undefined && c >= 32 && c < 127 && !symbolic) text = String.fromCharCode(c);
      out.push({ text, width: widthOf(c), space: c === 32 });
    }
    return out;
  });
}
