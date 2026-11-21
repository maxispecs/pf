/**
 * Declarative layout files: JSON that says what goes where, never code. `validateLayout` checks the shape and
 * refuses unknown keys; `layoutTemplate` turns a valid layout into a `PdfTemplate`.
 *
 * ```json
 * {
 *   "schema": 1,
 *   "page": { "size": "A4", "margin": 54 },
 *   "header": { "left": "{{param.company}}", "right": "{{date}}", "rule": true },
 *   "footer": { "center": "Page {{page}} of {{pages}}" },
 *   "start": [{ "type": "heading", "text": "{{param.title}}" }],
 *   "body": { "layout": "table", "columns": ["id", "name"] },
 *   "end": [{ "type": "text", "text": "{{count}} rows" }]
 * }
 * ```
 * `body` is a built-in layout with its options, or `{ "each": [blocks] }`, which draws the blocks once per row.
 * Placeholders `{{name}}`: a column (in `each`), `index`, `count` (in `end`), `title`, `date`, `page`, `pages`
 * (bands only) and `param.<option>` for the sink's options.
 */
import { cellText } from '@pulpfixer/kit/csv';
import type { Row } from '@pulpfixer/kit/io';
import { PdfError } from '../errors.js';
import { PAGE_SIZES, parseColor, type Color, type PageSetup, type PdfDoc, type TextStyle } from '../write/doc.js';
import { BUILTIN_TEMPLATES } from './builtin.js';
import type { PdfTemplate, TemplateContext } from './types.js';
import { drawFields, valueLines } from './util.js';

export const LAYOUT_SCHEMA = 1;

export interface Band {
  left?: string;
  center?: string;
  right?: string;
  size?: number;
  color?: Color;
  /** A line under a header / above a footer. */
  rule?: boolean;
}

export type Block =
  | ({ type: 'text'; text: string; after?: number } & Pick<TextStyle, 'font' | 'size' | 'color' | 'bold' | 'italic' | 'align'>)
  | { type: 'heading'; text: string; level?: number; color?: Color }
  | { type: 'line'; color?: Color; width?: number }
  | { type: 'space'; height: number }
  | { type: 'pageBreak' }
  | { type: 'fields'; fields: { label: string; value: string }[]; size?: number; font?: string; color?: Color; labelWidth?: number };

export type Body = { each: Block[] } | ({ layout: string } & Record<string, unknown>);

export interface Layout {
  schema: 1;
  summary?: string;
  page?: PageSetup;
  font?: { family?: string; size?: number; color?: Color };
  header?: Band;
  footer?: Band;
  start?: Block[];
  body: Body;
  end?: Block[];
}

const MAX_TEXT = 20000;
const LAYOUT_NAMES = BUILTIN_TEMPLATES.map((t) => t.id);

type Obj = Record<string, unknown>;

class Invalid extends Error {}

const fail = (path: string, msg: string): never => {
  throw new Invalid(`${path}: ${msg}`);
};

function obj(v: unknown, path: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(path, 'must be an object');
  return v as Obj;
}

function keys(o: Obj, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown key (allowed: ${allowed.join(', ')})`);
}

function text(v: unknown, path: string): string {
  if (typeof v !== 'string') return fail(path, 'must be text');
  if (v.length > MAX_TEXT) return fail(path, `is longer than ${MAX_TEXT} characters`);
  const rest = v.replace(/\{\{\s*[A-Za-z0-9_.\- ]+?\s*\}\}/g, '');
  if (rest.includes('{{') || rest.includes('}}')) return fail(path, 'has an unclosed or empty {{placeholder}}');
  return v;
}

function number(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return fail(path, `must be a number from ${min} to ${max}`);
  return v;
}

function color(v: unknown, path: string): Color {
  try {
    parseColor(v as Color);
  } catch (e) {
    return fail(path, e instanceof PdfError ? e.message : 'is not a color');
  }
  return v as Color;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') return fail(path, 'must be true or false');
  return v;
}

function page(v: unknown, path: string): PageSetup {
  const o = obj(v, path);
  keys(o, ['size', 'orientation', 'margin'], path);
  const out: PageSetup = {};
  if (o.size !== undefined) {
    if (typeof o.size === 'string') {
      if (!(o.size in PAGE_SIZES)) fail(`${path}.size`, `must be one of ${Object.keys(PAGE_SIZES).join(', ')} or [width, height]`);
      out.size = o.size as keyof typeof PAGE_SIZES;
    } else if (Array.isArray(o.size) && o.size.length === 2) {
      out.size = [number(o.size[0], `${path}.size[0]`, 72, 14400), number(o.size[1], `${path}.size[1]`, 72, 14400)];
    } else fail(`${path}.size`, 'must be a size name or [width, height] in points');
  }
  if (o.orientation !== undefined) {
    if (o.orientation !== 'portrait' && o.orientation !== 'landscape') fail(`${path}.orientation`, 'must be portrait or landscape');
    out.orientation = o.orientation as 'portrait' | 'landscape';
  }
  if (o.margin !== undefined) {
    if (typeof o.margin === 'number') out.margin = number(o.margin, `${path}.margin`, 0, 400);
    else {
      const m = obj(o.margin, `${path}.margin`);
      keys(m, ['top', 'right', 'bottom', 'left'], `${path}.margin`);
      out.margin = Object.fromEntries(Object.entries(m).map(([k, x]) => [k, number(x, `${path}.margin.${k}`, 0, 400)]));
    }
  }
  return out;
}

function band(v: unknown, path: string): Band {
  const o = obj(v, path);
  keys(o, ['left', 'center', 'right', 'size', 'color', 'rule'], path);
  const out: Band = {};
  for (const k of ['left', 'center', 'right'] as const) if (o[k] !== undefined) out[k] = text(o[k], `${path}.${k}`);
  if (o.size !== undefined) out.size = number(o.size, `${path}.size`, 4, 72);
  if (o.color !== undefined) out.color = color(o.color, `${path}.color`);
  if (o.rule !== undefined) out.rule = bool(o.rule, `${path}.rule`);
  return out;
}

const STYLE_KEYS = ['font', 'size', 'color', 'bold', 'italic', 'align'] as const;

function style(o: Obj, path: string): TextStyle {
  const out: TextStyle = {};
  if (o.font !== undefined) out.font = text(o.font, `${path}.font`);
  if (o.size !== undefined) out.size = number(o.size, `${path}.size`, 4, 144);
  if (o.color !== undefined) out.color = color(o.color, `${path}.color`);
  if (o.bold !== undefined) out.bold = bool(o.bold, `${path}.bold`);
  if (o.italic !== undefined) out.italic = bool(o.italic, `${path}.italic`);
  if (o.align !== undefined) {
    if (o.align !== 'left' && o.align !== 'center' && o.align !== 'right') fail(`${path}.align`, 'must be left, center or right');
    out.align = o.align as 'left' | 'center' | 'right';
  }
  return out;
}

function block(v: unknown, path: string): Block {
  const o = obj(v, path);
  switch (o.type) {
    case 'text': {
      keys(o, ['type', 'text', 'after', ...STYLE_KEYS], path);
      return { type: 'text', text: text(o.text, `${path}.text`), ...(o.after !== undefined ? { after: number(o.after, `${path}.after`, 0, 500) } : {}), ...style(o, path) };
    }
    case 'heading': {
      keys(o, ['type', 'text', 'level', 'color'], path);
      return {
        type: 'heading',
        text: text(o.text, `${path}.text`),
        ...(o.level !== undefined ? { level: number(o.level, `${path}.level`, 1, 3) } : {}),
        ...(o.color !== undefined ? { color: color(o.color, `${path}.color`) } : {}),
      };
    }
    case 'line': {
      keys(o, ['type', 'color', 'width'], path);
      return { type: 'line', ...(o.color !== undefined ? { color: color(o.color, `${path}.color`) } : {}), ...(o.width !== undefined ? { width: number(o.width, `${path}.width`, 0.1, 20) } : {}) };
    }
    case 'space':
      keys(o, ['type', 'height'], path);
      return { type: 'space', height: number(o.height, `${path}.height`, 0, 500) };
    case 'pageBreak':
      keys(o, ['type'], path);
      return { type: 'pageBreak' };
    case 'fields': {
      keys(o, ['type', 'fields', 'size', 'font', 'color', 'labelWidth'], path);
      if (!Array.isArray(o.fields) || o.fields.length === 0 || o.fields.length > 200) return fail(`${path}.fields`, 'must be a list of 1 to 200 { label, value }');
      const fields = o.fields.map((f, i) => {
        const fo = obj(f, `${path}.fields[${i}]`);
        keys(fo, ['label', 'value'], `${path}.fields[${i}]`);
        return { label: text(fo.label, `${path}.fields[${i}].label`), value: text(fo.value, `${path}.fields[${i}].value`) };
      });
      return {
        type: 'fields',
        fields,
        ...(o.size !== undefined ? { size: number(o.size, `${path}.size`, 4, 144) } : {}),
        ...(o.font !== undefined ? { font: text(o.font, `${path}.font`) } : {}),
        ...(o.color !== undefined ? { color: color(o.color, `${path}.color`) } : {}),
        ...(o.labelWidth !== undefined ? { labelWidth: number(o.labelWidth, `${path}.labelWidth`, 10, 600) } : {}),
      };
    }
    default:
      return fail(`${path}.type`, 'must be one of text, heading, line, space, pageBreak, fields');
  }
}

function blocks(v: unknown, path: string): Block[] {
  if (!Array.isArray(v)) return fail(path, 'must be a list of blocks');
  if (v.length > 500) return fail(path, 'has more than 500 blocks');
  return v.map((b, i) => block(b, `${path}[${i}]`));
}

function body(v: unknown, path: string): Body {
  const o = obj(v, path);
  if ('each' in o) {
    keys(o, ['each'], path);
    return { each: blocks(o.each, `${path}.each`) };
  }
  if (typeof o.layout !== 'string' || !LAYOUT_NAMES.includes(o.layout)) return fail(`${path}.layout`, `must be one of ${LAYOUT_NAMES.join(', ')} (or use { "each": [blocks] })`);
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === o.layout)!;
  const allowed = ['layout', ...Object.keys(builtin.options ?? {})];
  keys(o, allowed, path);
  return o as Body;
}

/** The layout, or why it is not one. Unknown keys are refused. Never runs anything. */
export function validateLayout(json: unknown): Layout | string {
  try {
    const o = obj(json, 'layout');
    keys(o, ['schema', 'summary', 'page', 'font', 'header', 'footer', 'start', 'body', 'end'], 'layout');
    if (o.schema !== LAYOUT_SCHEMA) fail('schema', `must be ${LAYOUT_SCHEMA}`);
    if (o.body === undefined) fail('body', 'is required: a built-in layout ({ "layout": "table" }) or { "each": [blocks] }');
    const out: Layout = { schema: 1, body: body(o.body, 'body') };
    if (o.summary !== undefined) out.summary = text(o.summary, 'summary');
    if (o.page !== undefined) out.page = page(o.page, 'page');
    if (o.font !== undefined) {
      const f = obj(o.font, 'font');
      keys(f, ['family', 'size', 'color'], 'font');
      out.font = {
        ...(f.family !== undefined ? { family: text(f.family, 'font.family') } : {}),
        ...(f.size !== undefined ? { size: number(f.size, 'font.size', 4, 72) } : {}),
        ...(f.color !== undefined ? { color: color(f.color, 'font.color') } : {}),
      };
    }
    if (o.header !== undefined) out.header = band(o.header, 'header');
    if (o.footer !== undefined) out.footer = band(o.footer, 'footer');
    if (o.start !== undefined) out.start = blocks(o.start, 'start');
    if (o.end !== undefined) out.end = blocks(o.end, 'end');
    return out;
  } catch (e) {
    if (e instanceof Invalid) return e.message;
    throw e;
  }
}

// -- placeholders ---------------------------------------------------------------------------------------------

type Scope = Record<string, string>;

/** Replace `{{name}}` from the scope; an unknown name is an error that lists what is available. */
export function expand(template: string, scope: Scope): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.\- ]+?)\s*\}\}/g, (_m, name: string) => {
    const v = scope[name];
    if (v === undefined) throw new PdfError(`the layout uses {{${name}}}, which is not available here`, `available: ${Object.keys(scope).map((k) => `{{${k}}}`).join(', ') || '(none)'}`);
    return v;
  });
}

function paramsOf(options: Record<string, unknown>): Scope {
  const out: Scope = {};
  for (const [k, v] of Object.entries(options)) out[`param.${k}`] = valueLines(v).join('\n');
  return out;
}

function drawBlock(doc: PdfDoc, b: Block, scope: Scope): void {
  switch (b.type) {
    case 'text': {
      const { type: _t, text: t, after, ...st } = b;
      void _t;
      doc.paragraph(expand(t, scope), { ...st, ...(after !== undefined ? { after } : {}) });
      break;
    }
    case 'heading':
      doc.heading(expand(b.text, scope), b.level ?? 1, b.color !== undefined ? { color: b.color } : {});
      break;
    case 'line':
      doc.rule({ ...(b.color !== undefined ? { color: b.color } : {}), ...(b.width !== undefined ? { width: b.width } : {}) });
      break;
    case 'space':
      doc.space(b.height);
      break;
    case 'pageBreak':
      if (!doc.atTop) doc.newPage();
      break;
    case 'fields':
      drawFields(doc, b.fields.map((f) => [expand(f.label, scope), expand(f.value, scope)] as const), {
        ...(b.size !== undefined ? { size: b.size } : {}),
        ...(b.font !== undefined ? { font: b.font } : {}),
        ...(b.color !== undefined ? { color: b.color } : {}),
        ...(b.labelWidth !== undefined ? { labelWidth: b.labelWidth } : {}),
      });
      break;
  }
}

function drawBand(doc: PdfDoc, b: Band, kind: 'header' | 'footer', scope: Scope): void {
  const size = b.size ?? 9;
  const y = kind === 'header' ? doc.height - doc.margin.top / 2 - size / 2 : Math.max(10, doc.margin.bottom / 2 - size / 2);
  const st = { size, ...(b.color !== undefined ? { color: b.color } : { color: '#4b5563' }) };
  if (b.left) doc.text(expand(b.left, scope), { ...st, x: doc.margin.left, y });
  if (b.center) doc.text(expand(b.center, scope), { ...st, x: doc.width / 2, y, align: 'center' });
  if (b.right) doc.text(expand(b.right, scope), { ...st, x: doc.width - doc.margin.right, y, align: 'right' });
  if (b.rule) {
    const ry = kind === 'header' ? y - size * 0.6 : y + size * 1.4;
    doc.line(doc.margin.left, ry, doc.width - doc.margin.right, ry, { color: '#d1d5db' });
  }
}

/** A template that draws a validated layout. */
export function layoutTemplate(layout: Layout, id: string): PdfTemplate {
  const eachBlocks = (layout.body as { each?: unknown }).each;
  const each = Array.isArray(eachBlocks) ? (eachBlocks as Block[]) : null;
  const builtin = each ? null : BUILTIN_TEMPLATES.find((t) => t.id === (layout.body as { layout: string }).layout)!;
  const bodyOptions = (): Record<string, unknown> => {
    const { layout: _l, ...rest } = layout.body as { layout: string } & Record<string, unknown>;
    void _l;
    return { pageNumbers: false, ...rest };
  };
  const inner = (ctx: TemplateContext): TemplateContext => ({ ...ctx, options: bodyOptions(), state: (ctx.state.body ??= {}) as Record<string, unknown> });
  const base = (ctx: TemplateContext): Scope => ({ ...paramsOf(ctx.options), title: ctx.title ?? '', date: ctx.date });

  return {
    id,
    ...(layout.summary ? { summary: layout.summary } : {}),
    ...(layout.page ? { page: layout.page } : {}),
    async start(ctx) {
      const doc = ctx.doc;
      if (layout.font?.family) doc.defaults.font = layout.font.family;
      if (layout.font?.size) doc.defaults.size = layout.font.size;
      if (layout.font?.color !== undefined) doc.defaults.color = layout.font.color;
      doc.font();
      const scope = base(ctx);
      if (layout.header) doc.onEachPage((d, page, pages) => drawBand(d, layout.header!, 'header', { ...scope, page: String(page), pages: String(pages) }));
      if (layout.footer) doc.onEachPage((d, page, pages) => drawBand(d, layout.footer!, 'footer', { ...scope, page: String(page), pages: String(pages) }));
      for (const [i, b] of (layout.start ?? []).entries()) {
        try {
          drawBlock(doc, b, scope);
        } catch (e) {
          throw withPath(e, `start[${i}]`);
        }
      }
      // Bands are checked now so a bad placeholder does not wait for the last page.
      for (const bnd of [layout.header, layout.footer]) {
        for (const t of [bnd?.left, bnd?.center, bnd?.right]) if (t) expand(t, { ...scope, page: '1', pages: '1' });
      }
      if (builtin) await builtin.start?.(inner(ctx));
    },
    write(rows, ctx) {
      if (builtin) return builtin.write(rows, inner(ctx));
      const start = ctx.rowCount - rows.length;
      rows.forEach((row: Row, i) => {
        const scope: Scope = { ...base(ctx), index: String(start + i + 1) };
        for (const [k, v] of Object.entries(row)) scope[k] = cellText(v);
        for (const [n, b] of each!.entries()) {
          try {
            drawBlock(ctx.doc, b, scope);
          } catch (e) {
            throw withPath(e, `body.each[${n}]`);
          }
        }
      });
    },
    async finish(ctx) {
      if (builtin) await builtin.finish?.(inner(ctx));
      const scope = { ...base(ctx), count: String(ctx.rowCount) };
      for (const [i, b] of (layout.end ?? []).entries()) {
        try {
          drawBlock(ctx.doc, b, scope);
        } catch (e) {
          throw withPath(e, `end[${i}]`);
        }
      }
    },
  };
}

function withPath(e: unknown, where: string): unknown {
  if (e instanceof PdfError) {
    const err = new PdfError(`${where}: ${e.message}`, e.hint);
    return err;
  }
  return e;
}

/** Parse the text of a layout file. */
export function parseLayoutText(source: string, what: string): Layout {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (e) {
    throw new PdfError(`${what} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const v = validateLayout(json);
  if (typeof v === 'string') throw new PdfError(`${what} is not a valid layout: ${v}`);
  return v;
}

/** A starting point for `pf pdf templates new`. */
export function starterLayout(name: string): Record<string, unknown> {
  return {
    schema: LAYOUT_SCHEMA,
    summary: `${name}: a report with a title, a table and a row count`,
    page: { size: 'A4', orientation: 'portrait', margin: 54 },
    header: { left: '{{param.company}}', right: '{{date}}', rule: true },
    footer: { center: 'Page {{page}} of {{pages}}' },
    start: [
      { type: 'heading', text: '{{param.title}}' },
      { type: 'text', text: 'Generated on {{date}}', size: 9, color: 'gray' },
    ],
    body: { layout: 'table', size: 9, zebra: true },
    end: [{ type: 'text', text: '{{count}} rows', size: 9, color: 'gray' }],
  };
}
