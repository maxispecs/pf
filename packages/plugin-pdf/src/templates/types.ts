import type { Row } from '@pulpfixer/kit/io';
import { PdfError } from '../errors.js';
import type { PageSetup, PdfDoc } from '../write/doc.js';

/** What a template is given while a PDF is being made. */
export interface TemplateContext {
  doc: PdfDoc;
  /** The options of the sink (`pdfSink({ options })`, `pf pdf write --option`). */
  options: Record<string, unknown>;
  /** The document title from the sink config, if any. */
  title?: string;
  /** Today, `YYYY-MM-DD`. */
  date: string;
  /** How many rows the template has been given so far (counting the batch being written). */
  rowCount: number;
  /** Yours: keep what you need between `start`, `write` and `finish` here. A fresh object for each PDF. */
  state: Record<string, unknown>;
}

/**
 * A layout: how rows become pages. `start` runs once before the first rows, `write` once per batch of rows
 * (they arrive in order, in batches of at most the pipe's batch size), `finish` once after the last. All draw on
 * `ctx.doc` (see `PdfDoc`). A template is used for one PDF at a time but may be used for many PDFs: keep
 * per-PDF data in `ctx.state`, not in the template.
 */
export interface PdfTemplate {
  /** Name in `pf pdf templates`. */
  id: string;
  summary?: string;
  /** Page setup for this layout; the sink's `page` overrides it key by key. */
  page?: PageSetup;
  /**
   * The options the template understands, name to help text. When given, any other option is an error (a
   * typo should not pass quietly); leave it out to accept anything.
   */
  options?: Record<string, string>;
  start?(ctx: TemplateContext): void | Promise<void>;
  write(rows: Row[], ctx: TemplateContext): void | Promise<void>;
  finish?(ctx: TemplateContext): void | Promise<void>;
}

/** Declare a code template (checks its shape, returns it). */
export function definePdfTemplate(template: PdfTemplate): PdfTemplate {
  const bad = validatePdfTemplate(template);
  if (bad) throw new PdfError(bad);
  return template;
}

export function validatePdfTemplate(value: unknown): string | null {
  const t = value as Partial<PdfTemplate> | null;
  if (!t || typeof t !== 'object') return 'a PDF template must be an object';
  if (typeof t.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.id)) return 'a PDF template needs an id (letters, digits, dots, dashes)';
  if (typeof t.write !== 'function') return `PDF template "${t.id}" needs write(rows, ctx)`;
  if (t.start !== undefined && typeof t.start !== 'function') return `PDF template "${t.id}" has a start that is not a function`;
  if (t.finish !== undefined && typeof t.finish !== 'function') return `PDF template "${t.id}" has a finish that is not a function`;
  if (t.options !== undefined && (typeof t.options !== 'object' || t.options === null)) return `PDF template "${t.id}" has options that are not an object`;
  return null;
}
