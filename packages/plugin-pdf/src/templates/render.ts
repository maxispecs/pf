import type { Row } from '@pulpfixer/kit/io';
import { PdfError } from '../errors.js';
import { PdfDoc, type DocMeta, type PageSetup } from '../write/doc.js';
import { resolveTemplate } from './resolve.js';
import { validatePdfTemplate, type PdfTemplate, type TemplateContext } from './types.js';

export interface RenderOptions extends DocMeta {
  /** Page setup; overrides the template's, key by key. */
  page?: PageSetup;
  /** Handed to the template as `ctx.options`. */
  options?: Record<string, unknown>;
}

/** Makes one PDF: rows go in by batch, the file comes out of `finish`. The whole document is held in memory. */
export class PdfRenderer {
  readonly template: PdfTemplate;
  private readonly ctx: TemplateContext;
  private started = false;
  private done = false;
  private readonly doc: PdfDoc;

  constructor(template: PdfTemplate | string, opts: RenderOptions = {}) {
    this.template = typeof template === 'string' ? resolveTemplate(template) : template;
    const bad = validatePdfTemplate(this.template);
    if (bad) throw new PdfError(bad);
    const options = opts.options ?? {};
    const allowed = this.template.options;
    if (allowed) {
      const unknown = Object.keys(options).filter((k) => !(k in allowed));
      if (unknown.length) {
        throw new PdfError(`the template "${this.template.id}" has no option ${unknown.map((k) => `"${k}"`).join(', ')}`, `its options: ${Object.keys(allowed).join(', ') || '(none)'}`);
      }
    }
    const { page, options: _o, ...meta } = opts;
    void _o;
    this.doc = new PdfDoc({ ...this.template.page, ...page }, meta);
    this.ctx = { doc: this.doc, options, ...(opts.title ? { title: opts.title } : {}), date: (opts.date ?? new Date()).toISOString().slice(0, 10), rowCount: 0, state: {} };
  }

  get rows(): number {
    return this.ctx.rowCount;
  }
  get pages(): number {
    return this.doc.pageCount;
  }
  /** Characters the standard fonts could not show (written as `?`). */
  get replaced(): number {
    return this.doc.replaced;
  }

  private async begin(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.template.start?.(this.ctx);
  }

  async write(rows: Row[]): Promise<void> {
    if (this.done) throw new PdfError('the PDF is already finished');
    await this.begin();
    if (rows.length === 0) return;
    this.ctx.rowCount += rows.length;
    await this.template.write(rows, this.ctx);
  }

  async finish(): Promise<Buffer> {
    if (this.done) throw new PdfError('the PDF is already finished');
    await this.begin();
    this.done = true;
    await this.template.finish?.(this.ctx);
    return this.doc.finish();
  }
}

/** Make a PDF from rows with a template (an object, a built-in id, a layout file or a saved layout name). */
export async function renderPdf(rows: readonly Row[], template: PdfTemplate | string, opts: RenderOptions = {}): Promise<Buffer> {
  const r = new PdfRenderer(template, opts);
  await r.write([...rows]);
  return r.finish();
}
