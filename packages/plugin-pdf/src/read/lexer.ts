/**
 * The PDF object syntax: numbers, names, strings, arrays, dictionaries, references and keywords. One lexer
 * reads file objects, content streams and CMaps (`allowRefs` is off for the last two, where `1 0 R` is not a
 * reference).
 */
import { PdfError } from '../errors.js';

export class Name {
  constructor(readonly value: string) {}
}
export class Ref {
  constructor(readonly num: number, readonly gen: number) {}
}
/** A PDF string: bytes, not text (the font or the string's use decides the encoding). */
export class PdfString {
  constructor(readonly bytes: Buffer) {}
}
/** A keyword: `obj`, `stream`, or a content stream operator (`Tj`). */
export class Op {
  constructor(readonly op: string) {}
}
export type Dict = Map<string, PdfObj>;
export class Stream {
  constructor(readonly dict: Dict, readonly raw: Buffer) {}
}
export type PdfObj = null | boolean | number | Name | Ref | PdfString | PdfObj[] | Dict | Stream | Op;

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]); // ( ) < > [ ] { } / %
const isRegular = (b: number): boolean => !WS.has(b) && !DELIM.has(b);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const MAX_DEPTH = 64;

export class Lexer {
  pos: number;
  constructor(readonly buf: Buffer, pos = 0, private readonly allowRefs = true) {
    this.pos = pos;
  }

  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.buf.length;
  }

  skipWs(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** The next object. Throws at the end of the data. A stray delimiter comes back as an `Op`. */
  next(depth = 0): PdfObj {
    if (depth > MAX_DEPTH) throw new PdfError('PDF objects are nested too deeply');
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) throw new PdfError('unexpected end of PDF data');
    const c = b[this.pos]!;
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.dict(depth);
      }
      return this.hexString();
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfObj[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) break;
        if (b[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        arr.push(this.next(depth + 1));
      }
      return arr;
    }
    if (c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) {
      this.pos++;
      return new Op(String.fromCharCode(c));
    }
    if (c === 0x3e) {
      this.pos += b[this.pos + 1] === 0x3e ? 2 : 1;
      return new Op('>>');
    }
    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos]!)) this.pos++;
    const word = b.toString('latin1', start, this.pos);
    if (NUMBER.test(word)) {
      const n = Number(word);
      if (this.allowRefs && /^\d+$/.test(word)) return this.maybeRef(n);
      return n;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Op(word);
  }

  private maybeRef(num: number): PdfObj {
    const save = this.pos;
    this.skipWs();
    const s = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos]! >= 0x30 && this.buf[this.pos]! <= 0x39) this.pos++;
    if (this.pos > s && this.pos - s <= 5) {
      const gen = Number(this.buf.toString('latin1', s, this.pos));
      this.skipWs();
      if (this.buf[this.pos] === 0x52 && !isRegularAt(this.buf, this.pos + 1)) {
        this.pos++;
        return new Ref(num, gen);
      }
    }
    this.pos = save;
    return num;
  }

  private name(): Name {
    this.pos++;
    const b = this.buf;
    let s = '';
    while (this.pos < b.length && isRegular(b[this.pos]!)) {
      const c = b[this.pos]!;
      if (c === 0x23 && this.pos + 2 < b.length && /^[0-9A-Fa-f]{2}$/.test(b.toString('latin1', this.pos + 1, this.pos + 3))) {
        s += String.fromCharCode(parseInt(b.toString('latin1', this.pos + 1, this.pos + 3), 16));
        this.pos += 3;
      } else {
        s += String.fromCharCode(c);
        this.pos++;
      }
    }
    return new Name(s);
  }

  private literalString(): PdfString {
    const b = this.buf;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const e = b[this.pos++];
        if (e === undefined) break;
        if (e === 0x6e) out.push(10);
        else if (e === 0x72) out.push(13);
        else if (e === 0x74) out.push(9);
        else if (e === 0x62) out.push(8);
        else if (e === 0x66) out.push(12);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let i = 0; i < 2; i++) {
            const d = b[this.pos];
            if (d !== undefined && d >= 0x30 && d <= 0x37) {
              v = v * 8 + (d - 0x30);
              this.pos++;
            } else break;
          }
          out.push(v & 0xff);
        } else if (e === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (e === 10) {
          // line continuation
        } else out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 13) {
        if (b[this.pos] === 10) this.pos++;
        out.push(10);
      } else out.push(c);
    }
    return new PdfString(Buffer.from(out));
  }

  private hexString(): PdfString {
    const b = this.buf;
    this.pos++;
    const digits: number[] = [];
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x3e) break;
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
      if (v >= 0) digits.push(v);
    }
    if (digits.length % 2) digits.push(0);
    const out = Buffer.alloc(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = digits[2 * i]! * 16 + digits[2 * i + 1]!;
    return new PdfString(out);
  }

  private dict(depth: number): Dict {
    const d: Dict = new Map();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.next(depth + 1);
      if (!(key instanceof Name)) {
        if (key instanceof Op && (key.op === 'endobj' || key.op === 'stream')) {
          this.pos -= key.op.length;
          break;
        }
        continue; // not a key: skip it
      }
      this.skipWs();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        d.set(key.value, null);
        continue;
      }
      d.set(key.value, this.next(depth + 1));
    }
    return d;
  }

  /**
   * After a `BI` operator in a content stream: read the inline image dictionary and skip its data. The data
   * ends at an `EI` keyword set off by white space.
   */
  skipInlineImage(): void {
    for (;;) {
      this.skipWs();
      if (this.pos >= this.buf.length) return;
      const o = this.next();
      if (o instanceof Op && o.op === 'ID') break;
    }
    if (this.pos < this.buf.length && WS.has(this.buf[this.pos]!)) this.pos++;
    const b = this.buf;
    for (let i = this.pos; i + 1 < b.length; i++) {
      if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === this.pos || WS.has(b[i - 1]!)) && (i + 2 >= b.length || WS.has(b[i + 2]!))) {
        this.pos = i + 2;
        return;
      }
    }
    this.pos = b.length;
  }
}

function isRegularAt(b: Buffer, i: number): boolean {
  return i < b.length && isRegular(b[i]!);
}

export const isDict = (o: PdfObj | undefined): o is Dict => o instanceof Map;
