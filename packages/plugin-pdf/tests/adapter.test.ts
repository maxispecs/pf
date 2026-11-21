import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { validateIoAdapter, type IoContext, type Row } from '@pulpfixer/kit/io';
import { PdfError } from '../src/errors.js';
import { pdfAdapter, pdfSink, pdfSource, type PdfSinkConfig, type PdfSourceConfig } from '../src/adapter.js';
import { pdfPlugin } from '../src/index.js';
import { openPdf } from '../src/read/extract.js';
import { classicPdf, onePage, stream } from './builders.js';

const ctx = buildContext(os.tmpdir());
const logs: string[] = [];
const io = (over: Partial<IoContext> = {}): IoContext => ({ ctx, dryRun: false, log: (l) => logs.push(l), batchSize: 2, ...over });
const dir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pdf-'));
const leftovers = (d: string): string[] => fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));

const THREE_LINES = 'BT /F1 12 Tf 72 700 Td (alpha) Tj 0 -14 Td (beta) Tj 0 -14 Td (gamma) Tj ET';

function sample(d: string, name = 'in.pdf'): string {
  const file = path.join(d, name);
  fs.writeFileSync(
    file,
    classicPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R] >> >>'],
      [2, '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
      [4, stream('', THREE_LINES)],
      [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
      [6, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
      [7, stream('', 'BT /F1 10 Tf 20 250 Td (page two) Tj ET')],
      [8, '<< /FT /Tx /T (who) /V (Ada) >>'],
      [9, "<< /Title (Sample) /Author (Ada) /CreationDate (D:20260102030405Z) >>"],
    ], '/Info 9 0 R'),
  );
  return file;
}

async function read(config: PdfSourceConfig, over: Partial<IoContext> = {}): Promise<{ rows: Row[]; sizes: number[] }> {
  const source = await pdfAdapter.source!(config, io(over));
  const rows: Row[] = [];
  const sizes: number[] = [];
  try {
    for await (const b of source.batches()) {
      sizes.push(b.length);
      rows.push(...b);
    }
  } finally {
    await source.close();
  }
  return { rows, sizes };
}

async function write(config: PdfSinkConfig, batches: Row[][], ok = true, over: Partial<IoContext> = {}): Promise<void> {
  const sink = await pdfAdapter.sink!(config, io(over));
  try {
    for (const b of batches) await sink.write(b);
  } catch (e) {
    await sink.close(false);
    throw e;
  }
  await sink.close(ok);
}

test('the pdf adapter is a valid IO adapter, built in through the plugin', () => {
  assert.equal(validateIoAdapter(pdfAdapter), null);
  assert.equal(pdfAdapter.harmless, undefined);
  assert.deepEqual(pdfPlugin.ioAdapters, [pdfAdapter]);
  assert.equal(pdfPlugin.api, 3);
  assert.equal(pdfPlugin.commands[0]!.name, 'pdf');
  assert.deepEqual(pdfSource({ path: 'a.pdf' }), { adapter: 'pdf', config: { path: 'a.pdf' } });
  assert.deepEqual(pdfSink({ path: 'a.pdf', template: 'text' }).config, { mode: 'create', path: 'a.pdf', template: 'text' });
  assert.equal(pdfAdapter.describe({ path: 'in.pdf', extract: 'lines' }), 'pdf file in.pdf (lines)');
  assert.equal(pdfAdapter.describe({ path: 'out.pdf', template: 'table', mode: 'create' }), 'pdf file out.pdf (template table, create)');
  assert.equal(pdfAdapter.describe({ path: '-', mode: 'create' }), 'pdf on standard input/output (template table, create)');
});

test('a source gives lines by default, in batches, with page and position', async () => {
  const d = dir();
  const { rows, sizes } = await read({ path: sample(d) });
  assert.deepEqual(rows.map((r) => `${r.page}:${r.line}:${r.text}`), ['1:1:alpha', '1:2:beta', '1:3:gamma', '2:1:page two']);
  assert.deepEqual(sizes, [2, 2]);
  assert.equal(rows[0]!.y, 700);
});

test('every extract mode', async () => {
  const file = sample(dir());
  assert.deepEqual((await read({ path: file, extract: 'pages' })).rows, [
    { page: 1, text: 'alpha\nbeta\ngamma', width: 612, height: 792 },
    { page: 2, text: 'page two', width: 200, height: 300 },
  ]);
  assert.deepEqual((await read({ path: file, extract: 'text' })).rows, [{ pages: 2, text: 'alpha\nbeta\ngamma\n\npage two' }]);
  const items = (await read({ path: file, extract: 'items', pages: '2' })).rows;
  assert.equal(items.length, 1);
  assert.deepEqual({ ...items[0], width: 0 }, { page: 2, x: 20, y: 250, width: 0, size: 10, font: 'Helvetica', text: 'page two' });
  assert.ok((items[0]!.width as number) > 30);
  assert.deepEqual((await read({ path: file, extract: 'meta' })).rows, [
    { title: 'Sample', author: 'Ada', subject: null, keywords: null, creator: null, producer: null, created: '2026-01-02T03:04:05.000Z', modified: null, pages: 2, version: '1.4' },
  ]);
  assert.deepEqual((await read({ path: file, extract: 'fields' })).rows, [{ name: 'who', type: 'text', value: 'Ada' }]);
});

test('pages: a range, a number, a list; and bad ones are errors', async () => {
  const file = sample(dir());
  assert.deepEqual((await read({ path: file, pages: '2-' })).rows.map((r) => r.text), ['page two']);
  assert.deepEqual((await read({ path: file, pages: 1 })).rows.length, 3);
  assert.deepEqual((await read({ path: file, pages: [2, 1] })).rows.length, 4);
  await assert.rejects(read({ path: file, pages: '3' }), /out of range/);
  await assert.rejects(read({ path: file, pages: [0] }), /pages must be/);
  await assert.rejects(read({ path: file, extract: 'bogus' as 'lines' }), /extract must be one of/);
});

test('source problems: no config, no path, missing, a folder, not a PDF, encrypted, read twice', async () => {
  const d = dir();
  await assert.rejects(pdfAdapter.source!(null as never, io()), /needs a configuration object/);
  await assert.rejects(pdfAdapter.source!({ path: '' }, io()), /needs a path/);
  await assert.rejects(read({ path: path.join(d, 'nope.pdf') }), /does not exist/);
  await assert.rejects(read({ path: d }), /is not a file/);
  fs.writeFileSync(path.join(d, 'x.pdf'), 'plain text');
  await assert.rejects(read({ path: path.join(d, 'x.pdf') }), (e: unknown) => e instanceof PdfError && /x\.pdf: this is not a PDF/.test(e.message));
  fs.writeFileSync(path.join(d, 'enc.pdf'), onePage('', { trailerExtra: '/Encrypt 9 0 R', extra: [[9, '<< /Filter /Standard >>']] }));
  await assert.rejects(read({ path: path.join(d, 'enc.pdf') }), (e: unknown) => e instanceof PdfError && /encrypted/.test(e.message) && !!e.hint);
  const source = await pdfAdapter.source!({ path: sample(d) }, io());
  for await (const b of source.batches()) void b;
  await assert.rejects(async () => {
    for await (const b of source.batches()) void b;
  }, /read once/);
});

test('a sink writes a PDF from rows with a template and options, and nothing else is left behind', async () => {
  const d = dir();
  const out = path.join(d, 'out.pdf');
  await write({ path: out, template: 'table', title: 'T', author: 'A', options: { pageNumbers: false } }, [[{ a: 1, b: 'x' }], [{ a: 2, b: 'y' }]]);
  const f = openPdf(fs.readFileSync(out));
  assert.deepEqual(f.lines(1).map((l) => l.text), ['a b', '1 x', '2 y']);
  assert.equal(f.info().title, 'T');
  assert.deepEqual(leftovers(d), []);
  assert.deepEqual(fs.readdirSync(d), ['out.pdf']);
});

test('create never replaces; overwrite does and keeps the mode; a failed pipe leaves the file alone', async () => {
  const d = dir();
  const out = path.join(d, 'out.pdf');
  fs.writeFileSync(out, 'old');
  fs.chmodSync(out, 0o640);
  await assert.rejects(write({ path: out }, [[{ a: 1 }]]), /already exists: mode "create" never replaces/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'old');
  await write({ path: out, mode: 'overwrite', template: 'text', options: { pageNumbers: false } }, [[{ text: 'new' }]], false);
  assert.equal(fs.readFileSync(out, 'utf8'), 'old');
  assert.deepEqual(leftovers(d), []);
  await write({ path: out, mode: 'overwrite', template: 'text', options: { pageNumbers: false } }, [[{ text: 'new' }]]);
  assert.equal(openPdf(fs.readFileSync(out)).text(1), 'new');
  assert.equal(fs.statSync(out).mode & 0o777, 0o640);
  assert.deepEqual(leftovers(d), []);
  // a template error mid-pipe: nothing is written
  const bad = path.join(d, 'bad.pdf');
  await assert.rejects(write({ path: bad, template: 'text' }, [[{ a: 1, b: 2 }]]), /which column/);
  assert.equal(fs.existsSync(bad), false);
  assert.deepEqual(leftovers(d), []);
});

test('a dry run renders (so the template is checked) but writes nothing and says what it would do', async () => {
  const d = dir();
  logs.length = 0;
  await write({ path: path.join(d, 'out.pdf') }, [[{ a: 1 }, { a: 2 }]], true, { dryRun: true });
  assert.deepEqual(fs.readdirSync(d), []);
  assert.match(logs.join('\n'), /would write a PDF \(2 rows, 1 page\) to .*out\.pdf/);
  await assert.rejects(write({ path: path.join(d, 'out.pdf'), template: 'text' }, [[{ a: 1, b: 2 }]], true, { dryRun: true }), /which column/);
  fs.writeFileSync(path.join(d, 'there.pdf'), 'x');
  logs.length = 0;
  await write({ path: path.join(d, 'there.pdf'), mode: 'overwrite' }, [[{ a: 1 }]], true, { dryRun: true });
  assert.match(logs.join('\n'), /would replace .*there\.pdf with a PDF/);
  assert.equal(fs.readFileSync(path.join(d, 'there.pdf'), 'utf8'), 'x');
});

test('sink problems: bad mode, missing folder, unknown template, unknown option, bad config', async () => {
  const d = dir();
  await assert.rejects(pdfAdapter.sink!({ path: path.join(d, 'a.pdf'), mode: 'append' as 'create' }, io()), /mode must be one of create, overwrite/);
  await assert.rejects(pdfAdapter.sink!({ path: path.join(d, 'no', 'a.pdf') }, io()), /folder .* does not exist/);
  await assert.rejects(pdfAdapter.sink!({ path: d }, io()), /already exists|is not a file/);
  await assert.rejects(pdfAdapter.sink!({ path: path.join(d, 'a.pdf'), template: 'nothing' }, io()), /no PDF template "nothing"/);
  await assert.rejects(pdfAdapter.sink!({ path: path.join(d, 'a.pdf'), options: { nope: 1 } }, io()), /no option "nope"/);
  await assert.rejects(pdfAdapter.sink!({ path: path.join(d, 'a.pdf'), template: { id: 'x' } as never }, io()), /needs write/);
  await assert.rejects(pdfAdapter.sink!({ path: path.join(d, 'a.pdf'), title: 5 as never }, io()), /title must be text/);
  await assert.rejects(pdfAdapter.sink!({ path: path.join(d, 'a.pdf'), options: [] as never }, io()), /options must be an object/);
  assert.deepEqual(fs.readdirSync(d), []);
});

test('characters the fonts cannot show are reported once through the log', async () => {
  const d = dir();
  logs.length = 0;
  await write({ path: path.join(d, 'o.pdf'), template: 'text' }, [[{ text: '日本語' }]]);
  assert.match(logs.join('\n'), /3 characters outside the standard fonts' Latin-1 range written as "\?"/);
});

test('a PDF read and written again keeps its lines (source into sink)', async () => {
  const d = dir();
  const { rows } = await read({ path: sample(d), pages: 1 });
  const out = path.join(d, 'copy.pdf');
  await write({ path: out, template: 'lines', options: { pageNumbers: false } }, [rows]);
  assert.deepEqual(openPdf(fs.readFileSync(out)).lines(1).map((l) => l.text), ['alpha', 'beta', 'gamma']);
});
