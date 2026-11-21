/**
 * The built-in layouts: `text` (paragraphs), `lines` (monospaced lines), `table` and `records`. Each takes
 * options from the sink (`title`, `pageNumbers`, `size`, `font` and its own).
 */
import { cellText, columnsOf } from '@pulpfixer/kit/csv';
import type { Row } from '@pulpfixer/kit/io';
import { PdfError } from '../errors.js';
import type { PdfTable, TableColumn } from '../write/doc.js';
import type { PdfTemplate, TemplateContext } from './types.js';
import { drawFields, Opts, pageNumberFooter, pickField, valueLines } from './util.js';

const COMMON = {
  title: 'a heading printed at the top of the first page',
  pageNumbers: 'print "Page n of N" at the bottom (default true)',
  size: 'font size in points',
  font: 'Helvetica, Times-Roman or Courier (with -Bold / -Italic), or sans / serif / mono',
};

function setup(ctx: TemplateContext, id: string, size: number, font: string): Opts {
  const o = new Opts(ctx.options, `the ${id} template`);
  ctx.doc.defaults.size = o.num('size', size, 4, 72);
  ctx.doc.defaults.font = o.str('font', font);
  ctx.doc.font(); // an unknown font is an error now, not on the first row
  const title = o.str('title');
  if (title) ctx.doc.heading(title, 1);
  if (o.bool('pageNumbers', true)) pageNumberFooter(ctx.doc);
  return o;
}

const optsOf = (ctx: TemplateContext, id: string): Opts => new Opts(ctx.options, `the ${id} template`);

/** `text`: the text column of each row, as paragraphs (line breaks kept). */
export const textTemplate: PdfTemplate = {
  id: 'text',
  summary: 'The text of each row as paragraphs (column "text", or the one column the rows have)',
  options: { ...COMMON, field: 'the column that holds the text (default: "text", else the only column)' },
  start(ctx) {
    setup(ctx, 'text', 11, 'Helvetica');
  },
  write(rows, ctx) {
    const field = optsOf(ctx, 'text').str('field');
    for (const row of rows) {
      const text = valueLines(row[pickField(row, field)]).join('\n');
      ctx.doc.paragraph(text, { after: ctx.doc.defaults.size * 0.8 });
    }
  },
};

/** `lines`: one line per row (or per element when a value is a list), monospaced, optionally numbered. */
export const linesTemplate: PdfTemplate = {
  id: 'lines',
  summary: 'One line per row (a list value gives one line per item), monospaced',
  options: {
    ...COMMON,
    field: 'the column that holds the line (default: "text", else the only column)',
    lineNumbers: 'number the lines (default false)',
    wrap: 'continue a long line on the next one (default true; false cuts it off)',
  },
  start(ctx) {
    setup(ctx, 'lines', 9, 'Courier');
    ctx.state.next = 1;
  },
  write(rows, ctx) {
    const o = optsOf(ctx, 'lines');
    const field = o.str('field');
    const list = rows.flatMap((row) => valueLines(row[pickField(row, field)]));
    const startAt = ctx.state.next as number;
    ctx.state.next = startAt + list.length;
    ctx.doc.lines(list, { lineNumbers: o.bool('lineNumbers', false), wrap: o.bool('wrap', true), startAt, numberDigits: 4 });
  },
};

interface ColumnSpec extends TableColumn {
  key: string;
}

/** Columns from an option: `["a","b"]`, `"a,b"`, or `[{ "key": "a", "title": "A", "width": 80, "align": "right" }]`. */
export function parseColumns(raw: unknown): ColumnSpec[] | undefined {
  if (raw === undefined) return undefined;
  const list = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
  if (!Array.isArray(list) || list.length === 0) throw new PdfError('columns must be a list of column names (or of { key, title, width, align })');
  const cols = list.map((c, i): ColumnSpec => {
    if (typeof c === 'string' && c !== '') return { key: c, title: c };
    const o = c as Partial<ColumnSpec> | null;
    if (!o || typeof o !== 'object' || typeof o.key !== 'string' || o.key === '') throw new PdfError(`column ${i + 1} needs a key`);
    if (o.title !== undefined && typeof o.title !== 'string') throw new PdfError(`column "${o.key}": title must be text`);
    if (o.width !== undefined && (typeof o.width !== 'number' || !(o.width > 0))) throw new PdfError(`column "${o.key}": width must be a number of points`);
    if (o.align !== undefined && !['left', 'right', 'center'].includes(o.align)) throw new PdfError(`column "${o.key}": align must be left, right or center`);
    return { key: o.key, title: o.title ?? o.key, ...(o.width ? { width: o.width } : {}), ...(o.align ? { align: o.align } : {}) };
  });
  if (new Set(cols.map((c) => c.key)).size !== cols.length) throw new PdfError('columns lists a column twice');
  return cols;
}

/** `table`: rows as a table with a header row that repeats on every page. */
export const tableTemplate: PdfTemplate = {
  id: 'table',
  summary: 'Rows as a table; the header repeats on every page, numbers align right',
  options: {
    ...COMMON,
    columns: 'the columns and their order: names, or { key, title, width, align } (default: those of the first rows)',
    zebra: 'shade every other row (default true)',
    header: 'draw the header row (default true)',
  },
  start(ctx) {
    setup(ctx, 'table', 9, 'Helvetica');
  },
  write(rows, ctx) {
    const o = optsOf(ctx, 'table');
    const st = ctx.state as { table?: PdfTable; cols?: ColumnSpec[]; inferred?: boolean };
    const cell = (r: Row, c: ColumnSpec): string => cellText(r[c.key]);
    if (!st.table) {
      const given = parseColumns(o.raw('columns'));
      st.inferred = !given;
      const cols: ColumnSpec[] = given ?? columnsOf(rows).map((k) => ({ key: k, title: k }));
      if (cols.length === 0) throw new PdfError('the rows have no columns to put in a table');
      st.cols = cols.map((c) => {
        if (c.align) return c;
        const vals = rows.map((r) => r[c.key]).filter((v) => v !== null && v !== undefined);
        const numeric = vals.length > 0 && vals.every((v) => typeof v === 'number' || typeof v === 'bigint');
        return numeric ? { ...c, align: 'right' as const } : c;
      });
      const zebra = o.bool('zebra', true);
      st.table = ctx.doc.beginTable(st.cols, rows.map((r) => st.cols!.map((c) => cell(r, c))), { zebra, header: o.bool('header', true), size: ctx.doc.defaults.size, font: ctx.doc.defaults.font });
    }
    const cols = st.cols!;
    if (st.inferred) {
      for (const r of rows) {
        for (const k of Object.keys(r)) {
          if (!cols.some((c) => c.key === k)) throw new PdfError(`a row has the column "${k}", which the first rows did not have`, 'set the columns option to list every column');
        }
      }
    }
    st.table.add(rows.map((r) => cols.map((c) => cell(r, c))));
  },
  finish(ctx) {
    const t = (ctx.state as { table?: PdfTable }).table;
    if (t) t.end();
    else ctx.doc.paragraph('(no rows)', { color: '#6b7280' });
  },
};

/** `records`: each row as a block of `label: value` lines. */
export const recordsTemplate: PdfTemplate = {
  id: 'records',
  summary: 'Each row as a block of "label: value" lines, one block after another',
  options: {
    ...COMMON,
    columns: 'the columns to print and their order (default: all of each row)',
    titleField: 'a column printed as a heading above each block',
  },
  start(ctx) {
    setup(ctx, 'records', 10, 'Helvetica');
  },
  write(rows, ctx) {
    const o = optsOf(ctx, 'records');
    const cols = parseColumns(o.raw('columns'));
    const titleField = o.str('titleField');
    for (const row of rows) {
      const keys = cols ?? Object.keys(row).filter((k) => k !== titleField).map((k) => ({ key: k, title: k }));
      if (titleField) {
        if (!(titleField in row)) throw new PdfError(`the rows have no column "${titleField}"`, `columns: ${Object.keys(row).join(', ')}`);
        ctx.doc.heading(cellText(row[titleField]), 3);
      }
      drawFields(ctx.doc, keys.map((c) => [c.title, valueLines(row[c.key]).join('\n')] as const), { size: ctx.doc.defaults.size, font: ctx.doc.defaults.font });
      ctx.doc.rule();
    }
  },
};

export const BUILTIN_TEMPLATES: readonly PdfTemplate[] = [textTemplate, linesTemplate, tableTemplate, recordsTemplate];
