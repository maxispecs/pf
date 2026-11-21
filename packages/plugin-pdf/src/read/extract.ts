/**
 * What can be taken out of a PDF: metadata, page sizes, text (as items, lines, or page text) and form fields.
 * `openPdf(bytes)` is the entry point; pages are read only when asked for.
 */
import { PDF_DOC_80 } from '../encodings.js';
import { PdfError } from '../errors.js';
import { Interpreter, type TextItem } from './content.js';
import { PdfDocument } from './document.js';
import { buildLines, linesToText, type Line } from './layout.js';
import { isDict, Name, PdfString, type Dict, type PdfObj } from './lexer.js';

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO 8601, or the file's own text when it is not a valid PDF date. */
  created?: string;
  modified?: string;
}

export interface PageSize {
  /** Points (1/72 inch), after the page's rotation. */
  width: number;
  height: number;
  rotate: number;
}

export interface PdfField {
  /** The dotted full name. */
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'button' | 'choice' | 'signature' | 'unknown';
  value: string;
}

/** A text string: UTF-16 or UTF-8 with a byte order mark, else PDFDocEncoding. */
export function decodeTextString(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return s;
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i]! | (b[i + 1]! << 8));
    return s;
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString('utf8', 3);
  let s = '';
  for (const c of b) s += c >= 0x80 && c <= 0xa0 ? (PDF_DOC_80[c - 0x80] ?? '') : String.fromCharCode(c);
  return s;
}

/** `D:20260115103000+01'00'` to an ISO string (UTC); the text itself when it does not parse. */
export function parsePdfDate(s: string): string {
  const m = /^D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?([Zz+-])?(?:(\d\d)'?(\d\d)?'?)?/.exec(s.trim());
  if (!m) return s;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', sign, oh = '00', om = '00'] = m;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
  if (Number.isNaN(t)) return s;
  if (sign === '+' || sign === '-') t -= (sign === '+' ? 1 : -1) * (Number(oh) * 60 + Number(om)) * 60000;
  return new Date(t).toISOString();
}

interface PageNode {
  dict: Dict;
  resources: Dict | null;
  box: number[];
  rotate: number;
}

const LETTER = [0, 0, 612, 792];

export class PdfFile {
  readonly pages: PageNode[];
  private readonly interp: Interpreter;

  private constructor(readonly doc: PdfDocument) {
    this.pages = collectPages(doc);
    this.interp = new Interpreter(doc);
  }

  static open(bytes: Buffer): PdfFile {
    return new PdfFile(PdfDocument.open(bytes));
  }

  get version(): string {
    return this.doc.version;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  private page(n: number): PageNode {
    const p = this.pages[n - 1];
    if (!p) throw new PdfError(`the file has no page ${n} (it has ${this.pages.length})`);
    return p;
  }

  pageSize(n: number): PageSize {
    const p = this.page(n);
    const [x1, y1, x2, y2] = p.box as [number, number, number, number];
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    const rotate = ((p.rotate % 360) + 360) % 360;
    return rotate === 90 || rotate === 270 ? { width: h, height: w, rotate } : { width: w, height: h, rotate };
  }

  items(n: number): TextItem[] {
    const p = this.page(n);
    return this.interp.page(p.dict, p.resources);
  }

  lines(n: number): Line[] {
    return buildLines(this.items(n));
  }

  text(n: number): string {
    return linesToText(this.lines(n));
  }

  info(): PdfInfo {
    const info = this.doc.getDict(this.doc.trailer, 'Info');
    const out: PdfInfo = {};
    if (!info) return out;
    const str = (key: string): string | undefined => {
      const v = this.doc.get(info, key);
      return v instanceof PdfString ? decodeTextString(v.bytes) : undefined;
    };
    for (const [key, field] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Keywords', 'keywords'], ['Creator', 'creator'], ['Producer', 'producer']] as const) {
      const v = str(key);
      if (v !== undefined && v !== '') out[field] = v;
    }
    const created = str('CreationDate');
    const modified = str('ModDate');
    if (created) out.created = parsePdfDate(created);
    if (modified) out.modified = parsePdfDate(modified);
    return out;
  }

  fields(): PdfField[] {
    const root = this.doc.root();
    const form = root ? this.doc.getDict(root, 'AcroForm') : null;
    const top = form ? this.doc.getArray(form, 'Fields') : null;
    const out: PdfField[] = [];
    if (!top) return out;
    const seen = new Set<Dict>();
    const walk = (node: PdfObj, prefix: string, ft: string | null, ff: number, v: PdfObj): void => {
      const d = this.doc.resolve(node);
      if (!isDict(d) || seen.has(d)) return;
      seen.add(d);
      const t = this.doc.get(d, 'T');
      const name = t instanceof PdfString ? (prefix ? `${prefix}.` : '') + decodeTextString(t.bytes) : prefix;
      const type = this.doc.getName(d, 'FT') ?? ft;
      const flags = this.doc.getNumber(d, 'Ff') ?? ff;
      const value = d.has('V') ? this.doc.get(d, 'V') : v;
      const kids = this.doc.getArray(d, 'Kids');
      const fieldKids = (kids ?? []).filter((k) => {
        const kd = this.doc.resolve(k);
        return isDict(kd) && kd.has('T');
      });
      if (fieldKids.length) {
        for (const k of fieldKids) walk(k, name, type, flags, value);
        return;
      }
      if (name === '' || !type) return;
      out.push({ name, type: fieldType(type, flags), value: this.fieldValue(value) });
    };
    for (const f of top) walk(f, '', null, 0, null);
    return out;
  }

  private fieldValue(v: PdfObj): string {
    if (v instanceof PdfString) return decodeTextString(v.bytes);
    if (v instanceof Name) return v.value;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map((x) => this.fieldValue(this.doc.resolve(x))).join(', ');
    return '';
  }
}

function fieldType(ft: string, ff: number): PdfField['type'] {
  switch (ft) {
    case 'Tx': return 'text';
    case 'Ch': return 'choice';
    case 'Sig': return 'signature';
    case 'Btn': return ff & 65536 ? 'button' : ff & 32768 ? 'radio' : 'checkbox';
    default: return 'unknown';
  }
}

function collectPages(doc: PdfDocument): PageNode[] {
  const out: PageNode[] = [];
  const root = doc.root();
  const top = root ? doc.getDict(root, 'Pages') : null;
  const seen = new Set<Dict>();
  const box = (d: Dict, inherited: number[]): number[] => {
    for (const key of ['CropBox', 'MediaBox']) {
      const a = doc.getArray(d, key)?.map((x) => doc.resolve(x));
      if (a && a.length === 4 && a.every((x) => typeof x === 'number')) return a as number[];
    }
    return inherited;
  };
  const walk = (node: Dict, resources: Dict | null, mediaBox: number[], rotate: number): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const res = doc.getDict(node, 'Resources') ?? resources;
    const mb = box(node, mediaBox);
    const rot = doc.getNumber(node, 'Rotate') ?? rotate;
    const kids = doc.getArray(node, 'Kids');
    if (kids && doc.getName(node, 'Type') !== 'Page') {
      for (const k of kids) {
        const kd = doc.resolve(k);
        if (isDict(kd)) walk(kd, res, mb, rot);
      }
    } else out.push({ dict: node, resources: res, box: mb, rotate: rot });
  };
  if (top) walk(top, null, LETTER, 0);
  if (out.length === 0) {
    // a broken page tree: take every page object in file order
    for (const n of doc.objectNumbers()) {
      const o = doc.getObject(n);
      if (isDict(o) && doc.getName(o, 'Type') === 'Page') walk(o, null, LETTER, 0);
    }
  }
  return out;
}

/** `"1-3,5"` or `"4-"` against a page count: the page numbers, ascending, once each. */
export function parsePageRange(spec: string, count: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (p === '') continue;
    const m = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(p);
    if (!m) throw new PdfError(`"${p}" is not a page or a page range`, 'use pages like 1-3,5 or 4-');
    const a = Number(m[1]);
    const z = m[2] === undefined ? a : m[2] === '' ? count : Number(m[2]);
    if (a < 1 || z < a) throw new PdfError(`"${p}" is not a valid page range`, 'pages count from 1 and a range goes up');
    if (a > count) throw new PdfError(`page ${a} is out of range: the file has ${count} page${count === 1 ? '' : 's'}`);
    for (let n = a; n <= Math.min(z, count); n++) pages.add(n);
  }
  if (pages.size === 0) throw new PdfError('no pages selected');
  return [...pages].sort((x, y) => x - y);
}

export const openPdf = (bytes: Buffer): PdfFile => PdfFile.open(bytes);
