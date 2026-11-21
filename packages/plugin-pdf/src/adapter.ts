import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ioRef, type IoAdapter, type IoContext, type IoRef, type IoSink, type IoSource, type Row, type RowBatches } from '@pulpfixer/kit/io';
import { PdfError } from './errors.js';
import { openPdf, parsePageRange, type PdfFile } from './read/extract.js';
import { PdfRenderer } from './templates/render.js';
import { validatePdfTemplate, type PdfTemplate } from './templates/types.js';
import type { PageSetup } from './write/doc.js';

export const EXTRACT_MODES = ['lines', 'pages', 'items', 'text', 'meta', 'fields'] as const;
export type ExtractMode = (typeof EXTRACT_MODES)[number];
export const PDF_MODES = ['create', 'overwrite'] as const;
export type PdfMode = (typeof PDF_MODES)[number];

export interface PdfSourceConfig {
  /** The file, or `-` for standard input. */
  path: string;
  /** What the rows are (default `lines`). See the table in the docs. */
  extract?: ExtractMode;
  /** Pages to read: `"1-3,5"`, `"4-"`, a number or a list of numbers (default all). */
  pages?: string | number | number[];
}

export interface PdfSinkConfig {
  /** The file, or `-` for standard output (refused on a terminal). */
  path: string;
  /** A built-in id (`text`, `lines`, `table`, `records`), a path to a `.json` layout, a saved layout name, or a `PdfTemplate`. Default `table`. */
  template?: string | PdfTemplate;
  /** Handed to the template (its `ctx.options`). */
  options?: Record<string, unknown>;
  page?: PageSetup;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  /** `create` (default) refuses a file that exists, `overwrite` replaces it. */
  mode?: PdfMode;
}

export type PdfConfig = PdfSourceConfig | PdfSinkConfig;

const STDIO = '-';
const errnoCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const round = (n: number): number => Math.round(n * 100) / 100;

function checkPath(config: unknown, what: string): Partial<PdfSourceConfig & PdfSinkConfig> & { path: string } {
  const c = config as Partial<PdfSourceConfig & PdfSinkConfig> | null;
  if (!c || typeof c !== 'object') throw new PdfError(`the pdf ${what} needs a configuration object`);
  if (typeof c.path !== 'string' || c.path === '') throw new PdfError(`the pdf ${what} needs a path (or "-" for standard input/output)`);
  return c as Partial<PdfSourceConfig & PdfSinkConfig> & { path: string };
}

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return null;
    throw e;
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Which pages a source reads. */
export function selectPages(pdf: PdfFile, pages: PdfSourceConfig['pages']): number[] {
  const count = pdf.pageCount;
  if (pages === undefined) return Array.from({ length: count }, (_, i) => i + 1);
  if (typeof pages === 'string') return parsePageRange(pages, count);
  const list = typeof pages === 'number' ? [pages] : pages;
  if (!Array.isArray(list) || list.length === 0 || !list.every((n) => Number.isInteger(n) && n >= 1)) throw new PdfError('pages must be a range like "1-3,5", a page number or a list of page numbers');
  const bad = list.find((n) => n > count);
  if (bad !== undefined) throw new PdfError(`page ${bad} is out of range: the file has ${count} page${count === 1 ? '' : 's'}`);
  return [...new Set(list)].sort((a, b) => a - b);
}

/** The rows of a PDF for one extract mode, one at a time. */
export function* extractRows(pdf: PdfFile, mode: ExtractMode, pages: number[]): Generator<Row> {
  switch (mode) {
    case 'lines':
      for (const page of pages) {
        let line = 0;
        for (const l of pdf.lines(page)) yield { page, line: ++line, text: l.text, y: round(l.y) };
      }
      return;
    case 'items':
      for (const page of pages) for (const i of pdf.items(page)) yield { page, x: round(i.x), y: round(i.y), width: round(i.width), size: round(i.size), font: i.font, text: i.text };
      return;
    case 'pages':
      for (const page of pages) {
        const { width, height } = pdf.pageSize(page);
        yield { page, text: pdf.text(page), width: round(width), height: round(height) };
      }
      return;
    case 'text':
      yield { pages: pages.length, text: pages.map((p) => pdf.text(p)).join('\n\n') };
      return;
    case 'meta': {
      const i = pdf.info();
      yield {
        title: i.title ?? null, author: i.author ?? null, subject: i.subject ?? null, keywords: i.keywords ?? null, creator: i.creator ?? null,
        producer: i.producer ?? null, created: i.created ?? null, modified: i.modified ?? null, pages: pdf.pageCount, version: pdf.version,
      };
      return;
    }
    case 'fields':
      for (const f of pdf.fields()) yield { name: f.name, type: f.type, value: f.value };
      return;
  }
}

async function openSource(config: unknown, io: IoContext): Promise<IoSource> {
  const c = checkPath(config, 'source') as PdfSourceConfig;
  const mode = c.extract ?? 'lines';
  if (!EXTRACT_MODES.includes(mode)) throw new PdfError(`extract must be one of ${EXTRACT_MODES.join(', ')} (got "${String(mode)}")`);
  const stdin = c.path === STDIO;
  let bytes: Buffer;
  if (stdin) bytes = await readStdin();
  else {
    const file = path.resolve(c.path);
    const st = await statOrNull(file).catch((e: unknown) => {
      throw new PdfError(`cannot read ${c.path}: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!st) throw new PdfError(`the PDF file ${c.path} does not exist`);
    if (!st.isFile()) throw new PdfError(`${c.path} is not a file`);
    bytes = await fs.promises.readFile(file).catch((e: unknown) => {
      throw new PdfError(`cannot read ${c.path}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  let pdf: PdfFile;
  try {
    pdf = openPdf(bytes);
  } catch (e) {
    throw e instanceof PdfError ? new PdfError(`${c.path}: ${e.message}`, e.hint) : new PdfError(`${c.path}: cannot read this PDF (${e instanceof Error ? e.message : String(e)})`);
  }
  const pages = selectPages(pdf, c.pages);
  let used = false;

  const batches = (): RowBatches =>
    (async function* () {
      if (used) throw new PdfError('a PDF source can be read once');
      used = true;
      let batch: Row[] = [];
      try {
        for (const row of extractRows(pdf, mode, pages)) {
          batch.push(row);
          if (batch.length >= io.batchSize) {
            yield batch;
            batch = [];
          }
        }
      } catch (e) {
        if (e instanceof PdfError) throw e;
        throw new PdfError(`${c.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (batch.length) yield batch;
    })();

  return { batches, close: async () => undefined };
}

/** Put the finished file at `target` without ever replacing one that is there (`create`). */
async function linkNew(tmp: string, target: string, shown: string): Promise<void> {
  const exists = new PdfError(`${shown} appeared while the pipe ran; mode "create" never replaces a file`);
  try {
    await fs.promises.link(tmp, target);
  } catch (e) {
    if (errnoCode(e) === 'EEXIST') throw exists;
    if (await statOrNull(target)) throw exists;
    await fs.promises.rename(tmp, target);
  }
}

async function openSink(config: unknown, io: IoContext): Promise<IoSink> {
  const c = checkPath(config, 'sink') as PdfSinkConfig;
  const mode = c.mode ?? 'create';
  if (!PDF_MODES.includes(mode)) throw new PdfError(`mode must be one of ${PDF_MODES.join(', ')} (got "${String(mode)}")`);
  if (c.template !== undefined && typeof c.template !== 'string') {
    const bad = validatePdfTemplate(c.template);
    if (bad) throw new PdfError(bad);
  }
  if (c.options !== undefined && (typeof c.options !== 'object' || c.options === null || Array.isArray(c.options))) throw new PdfError('options must be an object');
  for (const k of ['title', 'author', 'subject', 'keywords'] as const) if (c[k] !== undefined && typeof c[k] !== 'string') throw new PdfError(`${k} must be text`);

  const renderer = new PdfRenderer(c.template ?? 'table', {
    ...(c.page ? { page: c.page } : {}),
    ...(c.options ? { options: c.options } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(c.author ? { author: c.author } : {}),
    ...(c.subject ? { subject: c.subject } : {}),
    ...(c.keywords ? { keywords: c.keywords } : {}),
  });
  const stdout = c.path === STDIO;
  const shown = stdout ? 'standard output' : c.path;
  const n = (): string => `${renderer.rows} row${renderer.rows === 1 ? '' : 's'}, ${renderer.pages} page${renderer.pages === 1 ? '' : 's'}`;
  const warn = (): void => {
    if (renderer.replaced) io.log(`${renderer.replaced} character${renderer.replaced === 1 ? '' : 's'} outside the standard fonts' Latin-1 range written as "?"`);
  };

  if (stdout) {
    if (process.stdout.isTTY && !io.dryRun) throw new PdfError('refusing to write a PDF to the terminal', 'give a file path, or redirect standard output to a file');
    return {
      write: (batch) => renderer.write(batch),
      async close(ok) {
        if (!ok) return;
        const bytes = await renderer.finish();
        if (io.dryRun) return io.log(`would print a PDF (${n()}) on standard output`);
        warn();
        await new Promise<void>((resolve, reject) => process.stdout.write(bytes, (e) => (e ? reject(e) : resolve())));
      },
    };
  }

  const target = path.resolve(c.path);
  const dir = path.dirname(target);
  const dirStat = await statOrNull(dir);
  if (!dirStat?.isDirectory()) throw new PdfError(`the folder ${dir} does not exist`);
  const existing = await statOrNull(target);
  if (existing && !existing.isFile()) throw new PdfError(`${c.path} is not a file`);
  if (existing && mode === 'create') throw new PdfError(`${c.path} already exists: mode "create" never replaces a file (use mode "overwrite")`);

  return {
    write: (batch) => renderer.write(batch),
    async close(ok) {
      if (!ok) return;
      const bytes = await renderer.finish(); // also runs the template's finish, so a dry run checks it all
      if (io.dryRun) return io.log(existing ? `would replace ${shown} with a PDF (${n()})` : `would write a PDF (${n()}) to ${shown}`);
      warn();
      const tmp = path.join(dir, `.${path.basename(target)}.pf-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
      const handle = await fs.promises.open(tmp, 'wx');
      try {
        if (existing) await handle.chmod(existing.mode & 0o777).catch(() => undefined);
        await handle.writeFile(bytes);
        await handle.close();
        if (existing) await fs.promises.rename(tmp, target);
        else await linkNew(tmp, target, c.path);
      } finally {
        await handle.close().catch(() => undefined);
        await fs.promises.rm(tmp, { force: true });
      }
    },
  };
}

/**
 * PDF files as rows. A source takes what can be extracted from the file (lines of text, pages, positioned text,
 * metadata, form fields); a sink lays the rows out with a template and writes the file when the pipe has
 * worked (a temporary file next to the target is moved into place, so a failed pipe leaves nothing behind).
 */
export const pdfAdapter: IoAdapter<PdfConfig> = {
  id: 'pdf',
  label: 'PDF file',
  describe(config) {
    const c = config as Partial<PdfSourceConfig & PdfSinkConfig> | null;
    if (!c || typeof c.path !== 'string') return 'pdf file (?)';
    const where = c.path === STDIO ? 'pdf on standard input/output' : `pdf file ${c.path}`;
    if (c.template !== undefined || c.options !== undefined || c.mode !== undefined) {
      const t = typeof c.template === 'string' ? c.template : c.template ? c.template.id : 'table';
      return `${where} (template ${t}${c.mode ? `, ${c.mode}` : ''})`;
    }
    return c.extract ? `${where} (${c.extract})` : where;
  },
  source: openSource,
  sink: openSink,
};

/** An input that reads a PDF file. */
export const pdfSource = (config: PdfSourceConfig): IoRef<PdfSourceConfig> => ioRef('pdf', config);

/** An output that writes a PDF file (`mode` defaults to `create`, which refuses an existing file). */
export const pdfSink = (config: PdfSinkConfig): IoRef<PdfSinkConfig> => ioRef('pdf', { mode: 'create', ...config });
