/**
 * A content stream interpreter that only follows what places text: the graphics state matrix (`q`, `Q`, `cm`),
 * the text operators and form XObjects. It produces text items with their position on the page.
 */
import type { PdfDocument } from './document.js';
import { loadFont, type PdfFont } from './fonts.js';
import { isDict, Lexer, Name, Op, PdfString, Stream, type Dict, type PdfObj } from './lexer.js';

/** A run of text drawn by one show operator, in page space (points, origin bottom left). */
export interface TextItem {
  x: number;
  y: number;
  width: number;
  /** The font size as drawn. */
  size: number;
  font: string;
  text: string;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a x b`: apply `a` first, then `b` (the PDF convention for row vectors). */
function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

interface State {
  ctm: Matrix;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  font: PdfFont | null;
  size: number;
}

const MAX_FORM_DEPTH = 8;
const MAX_ITEMS = 2_000_000;

const nums = (args: PdfObj[], n: number): number[] | null => {
  const tail = args.slice(-n);
  return tail.length === n && tail.every((x) => typeof x === 'number') ? (tail as number[]) : null;
};

export class Interpreter {
  readonly items: TextItem[] = [];
  private fonts = new Map<Dict, PdfFont>();
  private active = new Set<Stream>();

  constructor(private readonly doc: PdfDocument) {}

  /** The text items of a page, in drawing order. */
  page(page: Dict, resources: Dict | null): TextItem[] {
    this.items.length = 0;
    const contents = this.doc.get(page, 'Contents');
    const streams: Stream[] = [];
    const add = (o: PdfObj): void => {
      const r = this.doc.resolve(o);
      if (r instanceof Stream) streams.push(r);
    };
    if (Array.isArray(contents)) contents.forEach(add);
    else add(contents);
    const chunks: Buffer[] = [];
    for (const s of streams) {
      try {
        chunks.push(this.doc.streamData(s), Buffer.from('\n'));
      } catch {
        // a content stream that will not decode is skipped
      }
    }
    this.run(Buffer.concat(chunks), resources, { ctm: IDENTITY, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, font: null, size: 0 }, 0);
    return [...this.items];
  }

  private font(resources: Dict | null, name: string): PdfFont | null {
    const fonts = resources ? this.doc.getDict(resources, 'Font') : null;
    const fd = fonts ? this.doc.get(fonts, name) : null;
    if (!isDict(fd)) return null;
    let f = this.fonts.get(fd);
    if (!f) {
      try {
        f = loadFont(this.doc, fd);
      } catch {
        return null;
      }
      this.fonts.set(fd, f);
    }
    return f;
  }

  private run(data: Buffer, resources: Dict | null, initial: State, depth: number): void {
    const lx = new Lexer(data, 0, false);
    let st: State = { ...initial };
    const stack: State[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let args: PdfObj[] = [];

    const show = (bytes: Buffer): void => {
      const font = st.font;
      if (!font || this.items.length >= MAX_ITEMS) return;
      let text = '';
      let adv = 0;
      for (const g of font.glyphs(bytes)) {
        text += g.text;
        adv += ((g.width / 1000) * st.size + st.tc + (g.space ? st.tw : 0)) * st.th;
      }
      const m = mul(tm, st.ctm);
      const size = Math.abs(st.size * Math.hypot(m[2], m[3]));
      if (text !== '' && size > 0) {
        this.items.push({ x: st.rise * m[2] + m[4], y: st.rise * m[3] + m[5], width: Math.abs(adv * Math.hypot(m[0], m[1])), size, font: font.name, text });
      }
      tm = mul(translate(adv, 0), tm);
    };
    const nextLine = (tx: number, ty: number): void => {
      tlm = mul(translate(tx, ty), tlm);
      tm = tlm;
    };

    while (!lx.atEnd()) {
      let o: PdfObj;
      try {
        o = lx.next();
      } catch {
        break;
      }
      if (!(o instanceof Op)) {
        args.push(o);
        if (args.length > 256) args.shift();
        continue;
      }
      switch (o.op) {
        case 'q': stack.push({ ...st }); break;
        case 'Q': if (stack.length) st = stack.pop()!; break;
        case 'cm': {
          const n = nums(args, 6);
          if (n) st.ctm = mul(n as Matrix, st.ctm);
          break;
        }
        case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
        case 'Tf': {
          const name = args[args.length - 2];
          const size = args[args.length - 1];
          if (name instanceof Name && typeof size === 'number') {
            st.font = this.font(resources, name.value);
            st.size = size;
          }
          break;
        }
        case 'Tc': if (typeof args[0] === 'number') st.tc = args[0]; break;
        case 'Tw': if (typeof args[0] === 'number') st.tw = args[0]; break;
        case 'Tz': if (typeof args[0] === 'number') st.th = args[0] / 100; break;
        case 'TL': if (typeof args[0] === 'number') st.tl = args[0]; break;
        case 'Ts': if (typeof args[0] === 'number') st.rise = args[0]; break;
        case 'Td': {
          const n = nums(args, 2);
          if (n) nextLine(n[0]!, n[1]!);
          break;
        }
        case 'TD': {
          const n = nums(args, 2);
          if (n) {
            st.tl = -n[1]!;
            nextLine(n[0]!, n[1]!);
          }
          break;
        }
        case 'Tm': {
          const n = nums(args, 6);
          if (n) {
            tm = n as Matrix;
            tlm = n as Matrix;
          }
          break;
        }
        case 'T*': nextLine(0, -st.tl); break;
        case 'Tj': {
          const s = args[args.length - 1];
          if (s instanceof PdfString) show(s.bytes);
          break;
        }
        case "'": {
          nextLine(0, -st.tl);
          const s = args[args.length - 1];
          if (s instanceof PdfString) show(s.bytes);
          break;
        }
        case '"': {
          const [aw, ac, s] = args.slice(-3);
          if (typeof aw === 'number') st.tw = aw;
          if (typeof ac === 'number') st.tc = ac;
          nextLine(0, -st.tl);
          if (s instanceof PdfString) show(s.bytes);
          break;
        }
        case 'TJ': {
          const arr = args[args.length - 1];
          if (Array.isArray(arr)) {
            for (const el of arr) {
              if (el instanceof PdfString) show(el.bytes);
              else if (typeof el === 'number') tm = mul(translate((-el / 1000) * st.size * st.th, 0), tm);
            }
          }
          break;
        }
        case 'Do': {
          const name = args[args.length - 1];
          if (name instanceof Name && depth < MAX_FORM_DEPTH) this.form(resources, name.value, st, depth);
          break;
        }
        case 'BI':
          try {
            lx.skipInlineImage();
          } catch {
            return;
          }
          break;
        default:
          break;
      }
      args = [];
    }
  }

  private form(resources: Dict | null, name: string, st: State, depth: number): void {
    const xobjects = resources ? this.doc.getDict(resources, 'XObject') : null;
    const x = xobjects ? this.doc.get(xobjects, name) : null;
    if (!(x instanceof Stream) || this.doc.getName(x.dict, 'Subtype') !== 'Form' || this.active.has(x)) return;
    const m = this.doc.getArray(x.dict, 'Matrix');
    const matrix = m && m.length === 6 && m.every((v) => typeof v === 'number') ? (m as Matrix) : IDENTITY;
    const res = this.doc.getDict(x.dict, 'Resources') ?? resources;
    this.active.add(x);
    try {
      this.run(this.doc.streamData(x), res, { ...st, ctm: mul(matrix, st.ctm) }, depth + 1);
    } catch {
      // an unreadable form draws nothing
    } finally {
      this.active.delete(x);
    }
  }
}
