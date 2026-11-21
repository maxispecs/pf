/**
 * `PdfDoc`: the drawing API templates write with. Low level calls place text, lines and rectangles at
 * coordinates (points, origin bottom left); the flow calls (`paragraph`, `heading`, `lines`, tables) keep a
 * cursor and start a new page when the content area is full. Headers and footers are drawn when the document is
 * finished, so they know the page count. Text is WinAnsi in the standard fonts: a character outside it is
 * written as `?` and counted in `replaced`.
 */
import { winAnsiByte } from '../encodings.js';
import { PdfError } from '../errors.js';
import { charWidth, parseFont, stringWidth, type StdFont } from '../metrics.js';
import { fontResource, serialize, type PageData } from './serialize.js';

export const PAGE_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
} as const satisfies Record<string, readonly [number, number]>;
export type PageSizeName = keyof typeof PAGE_SIZES;

/** A color: `#rgb`, `#rrggbb`, a name (`black`, `gray`, ...), a gray level 0..1, or `[r, g, b]` with each 0..1. */
export type Color = string | number | [number, number, number];

export interface PageSetup {
  /** A name or `[width, height]` in points. Default `A4`. */
  size?: PageSizeName | [number, number];
  orientation?: 'portrait' | 'landscape';
  /** One value for every side, or per side, in points. Default 54 (0.75 inch). */
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
}

export interface DocMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  /** The creation date (default now). */
  date?: Date;
}

export interface TextStyle {
  /** `Helvetica`, `Times-Roman`, `Courier` and their Bold / Italic forms, or `sans` / `serif` / `mono`. */
  font?: string;
  size?: number;
  color?: Color;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Line height as a multiple of the size (default 1.25). */
  leading?: number;
}

export interface TextOptions extends TextStyle {
  /** The left edge for `left` alignment, the middle for `center`, the right edge for `right`. */
  x: number;
  /** The baseline. */
  y: number;
}

export interface TableColumn {
  title: string;
  /** Points. Without one the width follows the content. */
  width?: number;
  align?: 'left' | 'right' | 'center';
}

export interface TableOptions {
  font?: string;
  size?: number;
  /** Shade every other row (default true). A color shades with it. */
  zebra?: boolean | Color;
  /** Draw the header row (default true); it repeats on each page. */
  header?: boolean;
  /** Cell padding in points (default 4). */
  padding?: number;
  /** Cells longer than this many lines are cut with an ellipsis (default 12). */
  maxLines?: number;
}

interface Page {
  ops: string[];
  fonts: Set<StdFont>;
}

type Margins = { top: number; right: number; bottom: number; left: number };
type PageHook = (doc: PdfDoc, page: number, pages: number) => void;

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [1, 1, 1], gray: [0.5, 0.5, 0.5], grey: [0.5, 0.5, 0.5], red: [0.8, 0.1, 0.1], green: [0.1, 0.5, 0.2], blue: [0.1, 0.25, 0.75],
};

/** A color as three 0..1 numbers. */
export function parseColor(c: Color): [number, number, number] {
  if (Array.isArray(c)) {
    if (c.length === 3 && c.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) return c;
  } else if (typeof c === 'number') {
    if (c >= 0 && c <= 1) return [c, c, c];
  } else if (typeof c === 'string') {
    const named = NAMED[c.toLowerCase()];
    if (named) return named;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (m) {
      const h = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join('') : m[1]!;
      return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
    }
  }
  throw new PdfError(`"${String(c)}" is not a color`, 'use #rrggbb, a name like gray, a gray level 0..1, or [r, g, b] with each 0..1');
}

const n2 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));
const rgb = (c: Color): string => parseColor(c).map((v) => n2(v)).join(' ');

export class PdfDoc {
  readonly width: number;
  readonly height: number;
  readonly margin: Margins;
  /** Characters outside WinAnsi that were written as `?`. */
  replaced = 0;
  /** Where the next flowing block starts: a baseline-independent y, counting up from the bottom. */
  cursorY: number;
  /** Defaults for text calls that do not say. */
  defaults: Required<Pick<TextStyle, 'font' | 'size'>> & { color: Color } = { font: 'Helvetica', size: 11, color: 'black' };

  private readonly pages: Page[] = [];
  private cur: Page;
  private pageNo = 1;
  private total = 0;
  private readonly hooks: PageHook[] = [];

  constructor(setup: PageSetup = {}, private readonly meta: DocMeta = {}) {
    const base = typeof setup.size === 'object' ? setup.size : PAGE_SIZES[setup.size ?? 'A4'];
    if (!base || !(base[0] > 0) || !(base[1] > 0)) throw new PdfError(`unknown page size "${String(setup.size)}"`, `use ${Object.keys(PAGE_SIZES).join(', ')} or [width, height] in points`);
    const [w, h] = base;
    const [short, long] = [Math.min(w, h), Math.max(w, h)];
    const landscape = setup.orientation === 'landscape';
    const portrait = setup.orientation === 'portrait';
    this.width = landscape ? long : portrait ? short : w;
    this.height = landscape ? short : portrait ? long : h;
    const m = setup.margin ?? 54;
    this.margin = typeof m === 'number' ? { top: m, right: m, bottom: m, left: m } : { top: m.top ?? 54, right: m.right ?? 54, bottom: m.bottom ?? 54, left: m.left ?? 54 };
    if (this.margin.left + this.margin.right >= this.width || this.margin.top + this.margin.bottom >= this.height) throw new PdfError('the margins leave no room on the page');
    this.cur = { ops: [], fonts: new Set() };
    this.pages.push(this.cur);
    this.cursorY = this.contentTop;
  }

  get contentWidth(): number {
    return this.width - this.margin.left - this.margin.right;
  }
  get contentTop(): number {
    return this.height - this.margin.top;
  }
  get contentBottom(): number {
    return this.margin.bottom;
  }
  /** The page being drawn on (1-based). */
  get pageNumber(): number {
    return this.pageNo;
  }
  /** How many pages there are so far (the final count while a header or footer is drawn). */
  get pageCount(): number {
    return this.total || this.pages.length;
  }

  // -- low level -------------------------------------------------------------------------------------------

  font(style: TextStyle = {}): StdFont {
    const spec = style.font ?? this.defaults.font;
    const f = parseFont(spec, style.bold, style.italic);
    if (!f) throw new PdfError(`unknown font "${spec}"`, 'use Helvetica, Times-Roman or Courier (with -Bold / -Italic), or sans / serif / mono');
    return f;
  }

  textWidth(text: string, style: TextStyle = {}): number {
    return stringWidth(this.font(style), this.clean(text), style.size ?? this.defaults.size);
  }

  private clean(text: string): string {
    return text.replace(/\t/g, '    ').replace(/[\r\n]+/g, ' ');
  }

  private literal(text: string): string {
    let s = '';
    for (const ch of text) {
      let b = winAnsiByte(ch);
      if (b === null) {
        b = 0x3f;
        this.replaced++;
      }
      s += b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b);
    }
    return `(${s})`;
  }

  /** One line of text. Does not wrap and does not move the cursor. */
  text(text: string, o: TextOptions): void {
    const style: TextStyle = { ...o };
    const font = this.font(style);
    const size = o.size ?? this.defaults.size;
    const t = this.clean(text);
    if (t === '') return;
    const w = stringWidth(font, t, size);
    const x = o.align === 'center' ? o.x - w / 2 : o.align === 'right' ? o.x - w : o.x;
    this.cur.fonts.add(font);
    this.cur.ops.push(`BT ${rgb(o.color ?? this.defaults.color)} rg /${fontResource(font)} ${n2(size)} Tf ${n2(x)} ${n2(o.y)} Td ${this.literal(t)} Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; color?: Color } = {}): void {
    this.cur.ops.push(`${rgb(o.color ?? 'black')} RG ${n2(o.width ?? 0.5)} w ${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, o: { fill?: Color; stroke?: Color; lineWidth?: number } = {}): void {
    if (!o.fill && !o.stroke) return;
    const ops: string[] = [];
    if (o.fill) ops.push(`${rgb(o.fill)} rg`);
    if (o.stroke) ops.push(`${rgb(o.stroke)} RG ${n2(o.lineWidth ?? 0.5)} w`);
    ops.push(`${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re ${o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S'}`);
    this.cur.ops.push(ops.join(' '));
  }

  /** Break text into lines no wider than `width`: at spaces, and inside a word that is too long. `\n` ends a line. */
  wrap(text: string, width: number, style: TextStyle = {}): string[] {
    const font = this.font(style);
    const size = style.size ?? this.defaults.size;
    const w = (s: string): number => stringWidth(font, s, size);
    const space = w(' ');
    const out: string[] = [];
    for (const para of text.replace(/\t/g, '    ').replace(/\r\n?/g, '\n').split('\n')) {
      if (para === '') {
        out.push('');
        continue;
      }
      let line = '';
      let lineW = 0;
      let started = false;
      for (const word of para.split(' ')) {
        const ww = w(word);
        const add = started ? space + ww : ww;
        if (started && lineW + add > width + 0.01 && line.trim() !== '') {
          out.push(line);
          line = '';
          lineW = 0;
          started = false;
        }
        if (ww > width) {
          if (started) {
            line += ' ';
            lineW += space;
          }
          const pieces = this.breakWord(word, width - lineW, width, font, size);
          for (let i = 0; i < pieces.length - 1; i++) {
            out.push(line + pieces[i]);
            line = '';
            lineW = 0;
          }
          line += pieces[pieces.length - 1]!;
          lineW = w(line);
          started = true;
          continue;
        }
        line += started ? ' ' + word : word;
        lineW += started ? space + ww : ww;
        started = true;
      }
      out.push(line);
    }
    return out;
  }

  private breakWord(word: string, first: number, width: number, font: StdFont, size: number): string[] {
    const pieces: string[] = [];
    let cur = '';
    let curW = 0;
    let limit = Math.max(first, 0);
    for (const ch of word) {
      const cw = (charWidth(font, ch) * size) / 1000;
      if (curW + cw > limit && cur !== '') {
        pieces.push(cur);
        cur = '';
        curW = 0;
        limit = width;
      }
      cur += ch;
      curW += cw;
    }
    pieces.push(cur);
    return pieces;
  }

  // -- flow ------------------------------------------------------------------------------------------------

  newPage(): void {
    this.cur = { ops: [], fonts: new Set() };
    this.pages.push(this.cur);
    this.pageNo = this.pages.length;
    this.cursorY = this.contentTop;
  }

  get atTop(): boolean {
    return this.cursorY >= this.contentTop - 0.01;
  }

  /** Room for `height` more points: a new page when there is not (unless the page is empty already). */
  ensure(height: number): void {
    if (this.cursorY - height < this.contentBottom && !this.atTop) this.newPage();
  }

  space(height: number): void {
    if (this.atTop) return;
    this.cursorY = Math.max(this.contentBottom, this.cursorY - height);
  }

  private leadingOf(style: TextStyle): number {
    return (style.size ?? this.defaults.size) * (style.leading ?? 1.25);
  }

  /** One line at the cursor, then the cursor moves down by the line height. */
  private flowLine(text: string, style: TextStyle, x0: number, width: number): void {
    const size = style.size ?? this.defaults.size;
    const lead = this.leadingOf(style);
    this.ensure(lead);
    const baseline = this.cursorY - lead + size * 0.28;
    const x = style.align === 'center' ? x0 + width / 2 : style.align === 'right' ? x0 + width : x0;
    this.text(text, { ...style, x, y: baseline });
    this.cursorY -= lead;
  }

  /** Wrapped text; `\n` breaks lines and a blank line is a blank line. Returns how many lines it drew. */
  paragraph(text: string, style: TextStyle & { after?: number } = {}): number {
    const lines = this.wrap(text, this.contentWidth, style);
    for (const l of lines) this.flowLine(l, style, this.margin.left, this.contentWidth);
    this.space(style.after ?? (style.size ?? this.defaults.size) * 0.4);
    return lines.length;
  }

  heading(text: string, level = 1, style: TextStyle = {}): void {
    const size = style.size ?? [20, 15, 12.5][Math.min(Math.max(level, 1), 3) - 1]!;
    const s: TextStyle = { bold: true, ...style, size, leading: style.leading ?? 1.2 };
    this.space(size * 0.5);
    this.ensure(this.leadingOf(s) * 2);
    this.paragraph(text, { ...s, after: size * 0.35 });
  }

  /** A horizontal rule across the content area. */
  rule(o: { color?: Color; width?: number } = {}): void {
    this.space(4);
    this.ensure(6);
    this.line(this.margin.left, this.cursorY, this.width - this.margin.right, this.cursorY, { color: o.color ?? '#9ca3af', ...(o.width ? { width: o.width } : {}) });
    this.space(6);
  }

  /**
   * Lines as given: spacing is kept, `\t` is four spaces. A line wider than the page is cut at the page edge
   * and continued on the next line (`wrap: false` cuts it off instead). `lineNumbers` numbers the source lines.
   */
  lines(list: readonly string[], style: TextStyle & { wrap?: boolean; lineNumbers?: boolean; startAt?: number; numberDigits?: number } = {}): void {
    const size = style.size ?? this.defaults.size;
    const start = style.startAt ?? 1;
    const digits = Math.max(style.numberDigits ?? 0, String(start + list.length - 1).length);
    const gutter = style.lineNumbers ? this.textWidth('0'.repeat(digits), { ...style, size }) + size * 0.8 : 0;
    const width = this.contentWidth - gutter;
    list.forEach((raw, i) => {
      const pieces = this.hardWrap(raw.replace(/\t/g, '    '), width, style, style.wrap === false);
      pieces.forEach((piece, k) => {
        this.ensure(this.leadingOf(style));
        if (gutter && k === 0) {
          this.text(String(start + i), { ...style, color: '#9ca3af', x: this.margin.left + gutter - size * 0.6, y: this.cursorY - this.leadingOf(style) + size * 0.28, align: 'right' });
        }
        this.flowLine(piece, { ...style, align: 'left' }, this.margin.left + gutter, width);
      });
    });
  }

  private hardWrap(line: string, width: number, style: TextStyle, cut: boolean): string[] {
    const font = this.font(style);
    const size = style.size ?? this.defaults.size;
    if (stringWidth(font, line, size) <= width) return [line];
    const pieces = this.breakWord(line, width, width, font, size);
    return cut ? [pieces[0]!] : pieces;
  }

  /** Start a table: the column widths are fitted from `sample` rows. Add rows with `add`, then `end`. */
  beginTable(columns: readonly TableColumn[], sample: readonly (readonly string[])[], opts: TableOptions = {}): PdfTable {
    return new PdfTable(this, columns, sample, opts);
  }

  /** A table in one call. */
  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[], opts: TableOptions = {}): void {
    const t = this.beginTable(columns, rows, opts);
    t.add(rows);
    t.end();
  }

  // -- headers, footers, output ----------------------------------------------------------------------------

  /** Called for every page when the document is finished, with the page number and the page count. */
  onEachPage(hook: PageHook): void {
    this.hooks.push(hook);
  }

  /** Draw on a page that already exists (what a hook does for the page it is called for). */
  withPage<T>(page: number, fn: () => T): T {
    const target = this.pages[page - 1];
    if (!target) throw new PdfError(`there is no page ${page}`);
    const [saved, savedNo] = [this.cur, this.pageNo];
    this.cur = target;
    this.pageNo = page;
    try {
      return fn();
    } finally {
      this.cur = saved;
      this.pageNo = savedNo;
    }
  }

  /** Draw the headers and footers and produce the PDF. */
  finish(): Buffer {
    this.total = this.pages.length;
    for (let i = 1; i <= this.total; i++) for (const h of this.hooks) this.withPage(i, () => h(this, i, this.total));
    const data: PageData[] = this.pages.map((p) => ({ width: this.width, height: this.height, content: p.ops.join('\n'), fonts: p.fonts }));
    return serialize(data, { ...this.meta, date: this.meta.date ?? new Date() });
  }
}

/** A table being drawn row by row (see `PdfDoc.beginTable`). */
export class PdfTable {
  readonly widths: number[];
  private readonly size: number;
  private readonly pad: number;
  private readonly lead: number;
  private readonly maxLines: number;
  private readonly showHeader: boolean;
  private readonly zebra: Color | null;
  private index = 0;
  private started = false;

  constructor(private readonly doc: PdfDoc, private readonly columns: readonly TableColumn[], sample: readonly (readonly string[])[], private readonly opts: TableOptions) {
    if (columns.length === 0) throw new PdfError('a table needs at least one column');
    this.size = opts.size ?? 9;
    this.pad = opts.padding ?? 4;
    this.lead = this.size * 1.25;
    this.showHeader = opts.header !== false;
    this.zebra = opts.zebra === false ? null : typeof opts.zebra === 'boolean' || opts.zebra === undefined ? '#f3f4f6' : opts.zebra;
    const bodyStyle = this.style(false);
    const headStyle = this.style(true);
    const natural = columns.map((c, i) => {
      let w = this.showHeader ? doc.textWidth(c.title, headStyle) : 0;
      for (const r of sample.slice(0, 200)) w = Math.max(w, doc.textWidth(r[i] ?? '', bodyStyle));
      return w + 2 * this.pad;
    });
    this.widths = fitWidths(columns.map((c) => c.width ?? null), natural, doc.contentWidth, this.size * 1.5 + 2 * this.pad);
    const rowRoom = doc.contentTop - doc.contentBottom - (this.showHeader ? this.lead + 2 * 3 : 0);
    this.maxLines = Math.max(1, Math.min(opts.maxLines ?? 12, Math.floor((rowRoom - 6) / this.lead)));
  }

  private style(bold: boolean): TextStyle {
    return { font: this.opts.font ?? 'Helvetica', size: this.size, bold };
  }

  private cells(values: readonly string[], bold: boolean): string[][] {
    return this.columns.map((_, i) => {
      const lines = this.doc.wrap(values[i] ?? '', Math.max(1, this.widths[i]! - 2 * this.pad), this.style(bold));
      if (lines.length <= this.maxLines) return lines;
      const kept = lines.slice(0, this.maxLines);
      kept[kept.length - 1] = kept[kept.length - 1]!.replace(/.{0,2}$/, '') + '…';
      return kept;
    });
  }

  private drawRow(cells: string[][], bold: boolean, fill: Color | null): void {
    const doc = this.doc;
    const rows = Math.max(1, ...cells.map((c) => c.length));
    const h = rows * this.lead + 6;
    const total = this.widths.reduce((a, b) => a + b, 0);
    const top = doc.cursorY;
    doc.rect(doc.margin.left, top - h, total, h, fill ? { fill } : {});
    let x = doc.margin.left;
    cells.forEach((lines, i) => {
      const col = this.columns[i]!;
      const w = this.widths[i]!;
      lines.forEach((l, k) => {
        const align = col.align ?? 'left';
        const ax = align === 'right' ? x + w - this.pad : align === 'center' ? x + w / 2 : x + this.pad;
        doc.text(l, { ...this.style(bold), x: ax, y: top - 3 - (k + 1) * this.lead + this.size * 0.28, align });
      });
      x += w;
    });
    doc.line(doc.margin.left, top - h, doc.margin.left + total, top - h, { color: bold ? '#6b7280' : '#d1d5db' });
    doc.cursorY = top - h;
  }

  private header(): void {
    if (!this.showHeader) return;
    this.drawRow(this.cells(this.columns.map((c) => c.title), true), true, '#e5e7eb');
  }

  add(rows: readonly (readonly string[])[]): void {
    const doc = this.doc;
    if (!this.started) {
      this.started = true;
      const first = rows[0] ? this.cells(rows[0], false) : [[]];
      doc.ensure((this.showHeader ? this.lead + 6 : 0) + Math.max(1, ...first.map((c) => c.length)) * this.lead + 6);
      this.header();
    }
    for (const r of rows) {
      const cells = this.cells(r, false);
      const h = Math.max(1, ...cells.map((c) => c.length)) * this.lead + 6;
      if (doc.cursorY - h < doc.contentBottom) {
        doc.newPage();
        this.header();
      }
      this.drawRow(cells, false, this.zebra && this.index % 2 === 1 ? this.zebra : null);
      this.index++;
    }
  }

  /** The table is over: a little room after it. */
  end(): void {
    if (!this.started) {
      this.started = true;
      this.header();
    }
    this.doc.space(this.size);
  }
}

/** Column widths: fixed ones kept, the others at their natural width, or shrunk to fit (long columns first). */
export function fitWidths(fixed: readonly (number | null)[], natural: readonly number[], available: number, min: number): number[] {
  const out = fixed.map((f) => f ?? 0);
  const free = fixed.map((f, i) => (f === null ? i : -1)).filter((i) => i >= 0);
  let room = available - out.reduce((a, b) => a + b, 0);
  let rest = [...free];
  for (;;) {
    if (rest.length === 0) break;
    const share = room / rest.length;
    const small = rest.filter((i) => natural[i]! <= share);
    if (small.length === 0) {
      for (const i of rest) out[i] = Math.max(min, share);
      break;
    }
    for (const i of small) {
      out[i] = Math.max(min, natural[i]!);
      room -= out[i]!;
    }
    rest = rest.filter((i) => !small.includes(i));
  }
  return out;
}
