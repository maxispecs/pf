/**
 * The PDF file structure: the header, cross-reference tables and streams (following `/Prev`), object streams,
 * and a rebuild by scanning when the cross-reference data is broken. Objects load lazily and are cached.
 * Encrypted files are refused.
 */
import { PdfError } from '../errors.js';
import { applyFilters } from './filters.js';
import { isDict, Lexer, Name, Op, Ref, Stream, type Dict, type PdfObj } from './lexer.js';

type Entry = { kind: 'file'; offset: number; gen: number } | { kind: 'objstm'; stm: number; index: number };

const MAX_REF_DEPTH = 32;

export class PdfDocument {
  readonly version: string;
  trailer: Dict = new Map();
  private xref = new Map<number, Entry>();
  private cache = new Map<number, PdfObj>();
  private loading = new Set<number>();
  private objStms = new Map<number, Map<number, PdfObj>>();
  private rebuilt = false;
  private decoded = new WeakMap<Stream, Buffer>();

  private constructor(readonly data: Buffer) {
    const head = data.toString('latin1', 0, Math.min(data.length, 1024));
    const m = /%PDF-(\d+\.\d+)/.exec(head);
    if (!m) throw new PdfError('this is not a PDF file (no %PDF header)');
    this.version = m[1]!;
  }

  static open(data: Buffer): PdfDocument {
    const doc = new PdfDocument(data);
    try {
      doc.readXrefChain();
      if (!doc.root()) throw new PdfError('the file has no document catalog');
    } catch (e) {
      if (e instanceof PdfError && /encrypted/.test(e.message)) throw e;
      doc.rebuild();
    }
    doc.checkEncryption();
    if (!doc.root()) throw new PdfError('the file has no document catalog (it is damaged)');
    return doc;
  }

  private checkEncryption(): void {
    if (this.trailer.has('Encrypt') && this.trailer.get('Encrypt') !== null) {
      throw new PdfError('this PDF is encrypted', 'pf reads PDFs that are not password protected; remove the protection first (for example with qpdf --decrypt)');
    }
  }

  /** The document catalog. */
  root(): Dict | null {
    const r = this.resolve(this.trailer.get('Root') ?? null);
    return isDict(r) ? r : null;
  }

  // -- objects ---------------------------------------------------------------------------------------------

  resolve(o: PdfObj | undefined): PdfObj {
    let cur: PdfObj = o ?? null;
    for (let i = 0; i < MAX_REF_DEPTH && cur instanceof Ref; i++) cur = this.getObject(cur.num);
    return cur instanceof Ref ? null : cur;
  }

  /** `dict[key]`, resolved. */
  get(dict: Dict, key: string): PdfObj {
    return this.resolve(dict.get(key));
  }

  getDict(dict: Dict, key: string): Dict | null {
    const v = this.get(dict, key);
    return isDict(v) ? v : v instanceof Stream ? v.dict : null;
  }

  getNumber(dict: Dict, key: string): number | null {
    const v = this.get(dict, key);
    return typeof v === 'number' ? v : null;
  }

  getName(dict: Dict, key: string): string | null {
    const v = this.get(dict, key);
    return v instanceof Name ? v.value : null;
  }

  getArray(dict: Dict, key: string): PdfObj[] | null {
    const v = this.get(dict, key);
    return Array.isArray(v) ? v : null;
  }

  getObject(num: number): PdfObj {
    if (this.cache.has(num)) return this.cache.get(num)!;
    if (this.loading.has(num)) return null;
    this.loading.add(num);
    try {
      const v = this.load(num);
      this.cache.set(num, v);
      return v;
    } finally {
      this.loading.delete(num);
    }
  }

  /** Every object number the file defines. */
  objectNumbers(): number[] {
    return [...this.xref.keys()].sort((a, b) => a - b);
  }

  private load(num: number): PdfObj {
    const e = this.xref.get(num);
    if (!e) return null;
    try {
      if (e.kind === 'objstm') return this.objStm(e.stm).get(num) ?? null;
      return this.parseAt(e.offset, num);
    } catch (err) {
      if (!this.rebuilt && err instanceof PdfError && /not where the cross-reference/.test(err.message)) {
        this.rebuild();
        return this.cache.get(num) ?? this.load(num);
      }
      if (err instanceof PdfError) return null;
      throw err;
    }
  }

  /** The object at a file offset: `num gen obj ... endobj`, with its stream when it has one. */
  private parseAt(offset: number, expect?: number): PdfObj {
    if (offset < 0 || offset >= this.data.length) throw new PdfError('object is not where the cross-reference says');
    const lx = new Lexer(this.data, offset);
    const n = lx.next();
    const g = lx.next();
    const kw = lx.next();
    if (typeof n !== 'number' || typeof g !== 'number' || !(kw instanceof Op) || kw.op !== 'obj') throw new PdfError('object is not where the cross-reference says');
    if (expect !== undefined && n !== expect) throw new PdfError('object is not where the cross-reference says');
    const obj = lx.next();
    if (!isDict(obj)) return obj;
    lx.skipWs();
    if (this.data.toString('latin1', lx.pos, lx.pos + 6) !== 'stream') return obj;
    let p = lx.pos + 6;
    if (this.data[p] === 13 && this.data[p + 1] === 10) p += 2;
    else if (this.data[p] === 10 || this.data[p] === 13) p += 1;
    let len = -1;
    const l = obj.get('Length');
    const lenVal = l instanceof Ref ? (l.num === n ? null : this.getObject(l.num)) : (l ?? null);
    if (typeof lenVal === 'number' && lenVal >= 0 && p + lenVal <= this.data.length) {
      const after = this.data.toString('latin1', p + lenVal, p + lenVal + 20).trimStart();
      if (after.startsWith('endstream') || after.startsWith('endobj')) len = lenVal;
    }
    if (len < 0) {
      const end = this.data.indexOf('endstream', p, 'latin1');
      let e = end < 0 ? this.data.length : end;
      if (e > p && this.data[e - 1] === 10) e--;
      if (e > p && this.data[e - 1] === 13) e--;
      len = Math.max(0, e - p);
    }
    return new Stream(obj, this.data.subarray(p, p + len));
  }

  private objStm(num: number): Map<number, PdfObj> {
    const hit = this.objStms.get(num);
    if (hit) return hit;
    const map = new Map<number, PdfObj>();
    this.objStms.set(num, map);
    const s = this.getObject(num);
    if (!(s instanceof Stream)) return map;
    const n = this.getNumber(s.dict, 'N') ?? 0;
    const first = this.getNumber(s.dict, 'First') ?? 0;
    const data = this.streamData(s);
    const head = new Lexer(data, 0, false);
    const pairs: [number, number][] = [];
    for (let i = 0; i < n && !head.atEnd(); i++) {
      const a = head.next();
      const b = head.next();
      if (typeof a === 'number' && typeof b === 'number') pairs.push([a, b]);
    }
    for (const [objNum, off] of pairs) {
      try {
        map.set(objNum, new Lexer(data, first + off, true).next());
      } catch {
        // an unreadable member is just missing
      }
    }
    return map;
  }

  /** A stream's decoded bytes. */
  streamData(s: Stream): Buffer {
    let d = this.decoded.get(s);
    if (!d) {
      d = applyFilters(s.raw, s.dict, (o) => this.resolve(o));
      this.decoded.set(s, d);
    }
    return d;
  }

  // -- cross-reference data --------------------------------------------------------------------------------

  private readXrefChain(): void {
    const tail = this.data.toString('latin1', Math.max(0, this.data.length - 2048));
    const at = tail.lastIndexOf('startxref');
    if (at < 0) throw new PdfError('no startxref');
    const m = /startxref\s+(\d+)/.exec(tail.slice(at));
    if (!m) throw new PdfError('no startxref offset');
    const seen = new Set<number>();
    const queue = [Number(m[1])];
    let first = true;
    while (queue.length) {
      const off = queue.shift()!;
      if (seen.has(off)) continue;
      seen.add(off);
      const trailer = this.readXrefAt(off);
      if (first) {
        this.trailer = trailer;
        first = false;
      } else {
        for (const [k, v] of trailer) if (!this.trailer.has(k)) this.trailer.set(k, v);
      }
      const stm = trailer.get('XRefStm');
      if (typeof stm === 'number') queue.unshift(stm);
      const prev = trailer.get('Prev');
      if (typeof prev === 'number') queue.push(prev);
    }
  }

  private add(num: number, e: Entry): void {
    if (!this.xref.has(num)) this.xref.set(num, e);
  }

  private readXrefAt(offset: number): Dict {
    if (offset < 0 || offset >= this.data.length) throw new PdfError('bad xref offset');
    const lx = new Lexer(this.data, offset, true);
    lx.skipWs();
    if (this.data.toString('latin1', lx.pos, lx.pos + 4) === 'xref') {
      lx.pos += 4;
      for (;;) {
        lx.skipWs();
        const a = lx.next();
        if (a instanceof Op) {
          if (a.op !== 'trailer') throw new PdfError('bad xref table');
          break;
        }
        const count = lx.next();
        if (typeof a !== 'number' || typeof count !== 'number') throw new PdfError('bad xref subsection');
        for (let i = 0; i < count; i++) {
          const off = lx.next();
          const gen = lx.next();
          const kind = lx.next();
          if (typeof off !== 'number' || typeof gen !== 'number' || !(kind instanceof Op)) throw new PdfError('bad xref entry');
          if (kind.op === 'n') this.add(a + i, { kind: 'file', offset: off, gen });
        }
      }
      const t = lx.next();
      if (!isDict(t)) throw new PdfError('bad trailer');
      return t;
    }
    const obj = this.parseAt(offset);
    if (!(obj instanceof Stream) || this.getName(obj.dict, 'Type') !== 'XRef') throw new PdfError('bad xref stream');
    const w = this.getArray(obj.dict, 'W')?.map((x) => (typeof x === 'number' ? x : 0));
    if (!w || w.length < 3) throw new PdfError('bad xref stream widths');
    const size = this.getNumber(obj.dict, 'Size') ?? 0;
    const index = (this.getArray(obj.dict, 'Index') ?? [0, size]).map((x) => (typeof x === 'number' ? x : 0));
    const data = this.streamData(obj);
    const rec = w[0]! + w[1]! + w[2]!;
    const field = (p: number, n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + data[p + i]!;
      return v;
    };
    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]!; i++, p += rec) {
        if (p + rec > data.length) break;
        const type = w[0] === 0 ? 1 : field(p, w[0]!);
        const f2 = field(p + w[0]!, w[1]!);
        const f3 = field(p + w[0]! + w[1]!, w[2]!);
        if (type === 1) this.add(index[s]! + i, { kind: 'file', offset: f2, gen: f3 });
        else if (type === 2) this.add(index[s]! + i, { kind: 'objstm', stm: f2, index: f3 });
      }
    }
    return obj.dict;
  }

  /** Forget the cross-reference data and find the objects by scanning the file. */
  private rebuild(): void {
    this.rebuilt = true;
    this.xref = new Map();
    this.cache = new Map();
    this.objStms = new Map();
    this.trailer = new Map();
    const text = this.data.toString('latin1');
    const re = /(?:^|[\r\n\s])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index + m[0].indexOf(m[1]!);
      this.xref.set(Number(m[1]), { kind: 'file', offset: start, gen: Number(m[2]) });
    }
    const trailers = /\btrailer\b/g;
    for (let m = trailers.exec(text); m; m = trailers.exec(text)) {
      try {
        const t = new Lexer(this.data, m.index + 7, true).next();
        if (isDict(t)) for (const [k, v] of t) this.trailer.set(k, v);
      } catch {
        // skip a trailer that does not parse
      }
    }
    // Object streams hold more objects; xref streams carry the trailer keys; a catalog is the fallback root.
    let catalog: number | null = null;
    for (const num of [...this.xref.keys()]) {
      let o: PdfObj;
      try {
        o = this.getObject(num);
      } catch {
        continue;
      }
      const dict = o instanceof Stream ? o.dict : isDict(o) ? o : null;
      if (!dict) continue;
      const type = dict.get('Type');
      if (o instanceof Stream && type instanceof Name) {
        if (type.value === 'XRef') for (const k of ['Root', 'Info', 'Encrypt', 'ID']) if (dict.has(k)) this.trailer.set(k, dict.get(k)!);
        if (type.value === 'ObjStm') {
          for (const member of this.objStm(num).keys()) if (!this.xref.has(member)) this.xref.set(member, { kind: 'objstm', stm: num, index: 0 });
        }
      }
      if (type instanceof Name && type.value === 'Catalog') catalog = num;
    }
    if (!this.root()) {
      for (const num of this.xref.keys()) {
        const o = this.getObject(num);
        if (isDict(o) && o.get('Type') instanceof Name && (o.get('Type') as Name).value === 'Catalog') catalog = num;
      }
      if (catalog !== null) this.trailer.set('Root', new Ref(catalog, 0));
    }
  }
}
