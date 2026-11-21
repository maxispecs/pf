import { cellText } from '@pulpfixer/kit/csv';
import type { Row } from '@pulpfixer/kit/io';
import { PdfError } from '../errors.js';
import type { Color, PdfDoc, TextStyle } from '../write/doc.js';

/** Typed reads of a template's options (they arrive from JSON, from `--option k=v` or from code). */
export class Opts {
  constructor(private readonly o: Record<string, unknown>, private readonly who: string) {}

  has(name: string): boolean {
    return this.o[name] !== undefined;
  }

  str(name: string): string | undefined;
  str(name: string, fallback: string): string;
  str(name: string, fallback?: string): string | undefined {
    const v = this.o[name];
    if (v === undefined) return fallback;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v !== 'string') throw new PdfError(`the option "${name}" of ${this.who} must be text`);
    return v;
  }

  num(name: string, fallback: number, min = 1, max = 500): number {
    const v = this.o[name];
    if (v === undefined) return fallback;
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new PdfError(`the option "${name}" of ${this.who} must be a number from ${min} to ${max}`);
    return n;
  }

  bool(name: string, fallback: boolean): boolean {
    const v = this.o[name];
    if (v === undefined) return fallback;
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new PdfError(`the option "${name}" of ${this.who} must be true or false`);
  }

  raw(name: string): unknown {
    return this.o[name];
  }
}

/** A row value as lines of text: an array is one line per element, text splits at line breaks. */
export function valueLines(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => valueLines(x));
  if (typeof v === 'string') return v.replace(/\r\n?/g, '\n').split('\n');
  return [cellText(v)];
}

/**
 * The column a text template reads: the `field` option, else `text`, else the row's only column. Anything
 * else is an error that names the columns.
 */
export function pickField(row: Row, field: string | undefined): string {
  if (field !== undefined) {
    if (!(field in row)) throw new PdfError(`the rows have no column "${field}"`, `columns: ${Object.keys(row).join(', ') || '(none)'}`);
    return field;
  }
  if ('text' in row) return 'text';
  const keys = Object.keys(row);
  if (keys.length === 1) return keys[0]!;
  throw new PdfError('this template does not know which column holds the text', `set the field option to one of: ${keys.join(', ')}`);
}

/** Label and value pairs: the label in bold on the left, the value wrapped beside it. */
export function drawFields(doc: PdfDoc, pairs: readonly (readonly [string, string])[], o: { size?: number; font?: string; color?: Color; labelWidth?: number } = {}): void {
  if (pairs.length === 0) return;
  const size = o.size ?? doc.defaults.size;
  const base: TextStyle = { size, ...(o.font ? { font: o.font } : {}), ...(o.color !== undefined ? { color: o.color } : {}) };
  const labelWidth = o.labelWidth ?? Math.min(doc.contentWidth * 0.4, Math.max(...pairs.map(([l]) => doc.textWidth(l, { ...base, bold: true }))) + size);
  const valueWidth = doc.contentWidth - labelWidth;
  const lead = size * 1.25;
  const wrapped = pairs.map(([l, v]) => [doc.wrap(l, labelWidth - size * 0.5, { ...base, bold: true }), doc.wrap(v, valueWidth, base)] as const);
  const height = wrapped.reduce((h, [a, b]) => h + Math.max(a.length, b.length) * lead, 0);
  if (height <= doc.contentTop - doc.contentBottom) doc.ensure(height);
  for (const [label, value] of wrapped) {
    const n = Math.max(label.length, value.length);
    doc.ensure(n * lead);
    for (let k = 0; k < n; k++) {
      const y = doc.cursorY - (k + 1) * lead + size * 0.28;
      if (label[k]) doc.text(label[k]!, { ...base, bold: true, x: doc.margin.left, y });
      if (value[k]) doc.text(value[k]!, { ...base, x: doc.margin.left + labelWidth, y });
    }
    doc.cursorY -= n * lead;
  }
}

/** The page number footer every built-in template offers. */
export function pageNumberFooter(doc: PdfDoc): void {
  doc.onEachPage((d, page, pages) => {
    d.text(`Page ${page} of ${pages}`, { x: d.width / 2, y: Math.max(14, d.margin.bottom / 2 - 4), size: 8, color: '#6b7280', align: 'center' });
  });
}
