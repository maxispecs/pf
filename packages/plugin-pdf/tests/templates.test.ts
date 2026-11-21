import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PdfError } from '../src/errors.js';
import { openPdf } from '../src/read/extract.js';
import { BUILTIN_TEMPLATES } from '../src/templates/builtin.js';
import { expand, layoutTemplate, parseLayoutText, starterLayout, validateLayout, type Layout } from '../src/templates/json.js';
import { PdfRenderer, renderPdf } from '../src/templates/render.js';
import { listUserTemplates, resolveTemplate } from '../src/templates/resolve.js';
import { definePdfTemplate, validatePdfTemplate } from '../src/templates/types.js';

const lines = (pdf: Buffer, page: number): string[] => openPdf(pdf).lines(page).map((l) => l.text);
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pdf-tpl-'));

function withHome<T>(home: string, fn: () => T): T {
  const saved = process.env.PF_HOME;
  process.env.PF_HOME = home;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = saved;
  }
}

test('validateLayout accepts the starter and says where a layout is wrong', () => {
  const ok = validateLayout(starterLayout('x'));
  assert.equal(typeof ok, 'object');
  const bad = (v: unknown): string => {
    const r = validateLayout(v);
    assert.equal(typeof r, 'string', JSON.stringify(v));
    return r as string;
  };
  assert.match(bad(null), /layout: must be an object/);
  assert.match(bad({ schema: 2, body: { layout: 'table' } }), /schema: must be 1/);
  assert.match(bad({ schema: 1 }), /body: is required/);
  assert.match(bad({ schema: 1, body: { layout: 'table' }, script: 'x' }), /layout\.script: unknown key/);
  assert.match(bad({ schema: 1, body: { layout: 'pie' } }), /body\.layout: must be one of text, lines, table, records/);
  assert.match(bad({ schema: 1, body: { layout: 'table', colums: [] } }), /body\.colums: unknown key/);
  assert.match(bad({ schema: 1, body: { each: [{ type: 'image' }] } }), /body\.each\[0\]\.type/);
  assert.match(bad({ schema: 1, body: { each: [{ type: 'text', text: 'a', size: 1000 }] } }), /body\.each\[0\]\.size: must be a number from 4 to 144/);
  assert.match(bad({ schema: 1, body: { each: [{ type: 'text', text: 'a {{b' }] } }), /unclosed or empty/);
  assert.match(bad({ schema: 1, body: { each: [{ type: 'text', text: 'a', color: 'ultraviolet' }] } }), /not a color/);
  assert.match(bad({ schema: 1, body: { layout: 'table' }, page: { size: 'B7' } }), /page\.size: must be one of/);
  assert.match(bad({ schema: 1, body: { layout: 'table' }, header: { top: 'x' } }), /header\.top: unknown key/);
  assert.match(bad({ schema: 1, body: { each: [{ type: 'fields', fields: [] }] } }), /fields: must be a list/);
  assert.throws(() => parseLayoutText('{nope', 'x.json'), /x\.json is not valid JSON/);
  assert.throws(() => parseLayoutText('{"schema":1}', 'x.json'), /x\.json is not a valid layout: body: is required/);
});

test('expand fills placeholders and lists what is available when one is unknown', () => {
  assert.equal(expand('a {{x}} b {{ y.z }}', { x: '1', 'y.z': '2' }), 'a 1 b 2');
  assert.throws(() => expand('{{nope}}', { a: '1' }), (e: unknown) => e instanceof PdfError && /\{\{nope\}\}/.test(e.message) && /\{\{a\}\}/.test(e.hint ?? ''));
});

test('the starter layout renders: header, title from options, table, row count', async () => {
  const template = layoutTemplate(validateLayout(starterLayout('report')) as Layout, 'report');
  const pdf = await renderPdf([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }], template, { date: new Date('2026-05-06T12:00:00Z'), options: { title: 'Customers', company: 'Acme' } });
  const f = openPdf(pdf);
  const all = f.lines(1).map((l) => l.text);
  assert.ok(all.includes('Acme 2026-05-06'), all.join(' | '));
  assert.ok(all.includes('Customers'));
  assert.ok(all.includes('Generated on 2026-05-06'));
  assert.ok(all.includes('id name'));
  assert.ok(all.includes('2 Grace'));
  assert.ok(all.includes('2 rows'));
  assert.ok(all.includes('Page 1 of 1'));
});

test('an each layout draws its blocks once per row with the row\'s values, and the page break and bands work', async () => {
  const layout = validateLayout({
    schema: 1,
    page: { size: [300, 300], margin: 30 },
    header: { left: 'Invoices', right: '{{page}}/{{pages}}' },
    body: {
      each: [
        { type: 'heading', text: 'Invoice {{index}}: {{customer}}', level: 2 },
        { type: 'fields', fields: [{ label: 'Total', value: '{{total}} EUR' }, { label: 'Due', value: '{{due}}' }] },
        { type: 'pageBreak' },
      ],
    },
    end: [{ type: 'text', text: 'Invoices: {{count}}' }],
  }) as Layout;
  const pdf = await renderPdf(
    [{ customer: 'Ada', total: 12.5, due: '2026-06-01' }, { customer: 'Grace', total: 30, due: '2026-06-15' }],
    layoutTemplate(layout, 'inv'),
  );
  const f = openPdf(pdf);
  assert.equal(f.pageCount, 3);
  assert.deepEqual(lines(pdf, 1), ['Invoices 1/3', 'Invoice 1: Ada', 'Total 12.5 EUR', 'Due 2026-06-01']);
  assert.deepEqual(lines(pdf, 2), ['Invoices 2/3', 'Invoice 2: Grace', 'Total 30 EUR', 'Due 2026-06-15']);
  assert.deepEqual(lines(pdf, 3), ['Invoices 3/3', 'Invoices: 2']);
});

test('an unknown placeholder fails with where it is and what the row has', async () => {
  const layout = validateLayout({ schema: 1, body: { each: [{ type: 'text', text: 'ok' }, { type: 'text', text: '{{nme}}' }] } }) as Layout;
  await assert.rejects(renderPdf([{ name: 'x' }], layoutTemplate(layout, 't')), (e: unknown) => e instanceof PdfError && /body\.each\[1\]/.test(e.message) && /\{\{nme\}\}/.test(e.message) && /\{\{name\}\}/.test(e.hint ?? ''));
  const early = validateLayout({ schema: 1, body: { layout: 'table' }, footer: { center: '{{nope}}' } }) as Layout;
  await assert.rejects(renderPdf([{ a: 1 }], layoutTemplate(early, 't')), /\{\{nope\}\}/);
});

test('a layout body can be any built-in layout with its options', async () => {
  const layout = validateLayout({ schema: 1, font: { family: 'Courier', size: 8 }, body: { layout: 'lines', lineNumbers: true }, start: [{ type: 'text', text: 'Log' }] }) as Layout;
  const pdf = await renderPdf([{ text: 'a' }, { text: 'b' }], layoutTemplate(layout, 'log'));
  assert.deepEqual(lines(pdf, 1), ['Log', '1 a', '2 b']);
  assert.equal(openPdf(pdf).items(1).find((i) => i.text === 'a')!.font, 'Courier');
});

test('a code template: start, write per batch and finish, with state, drawing with the doc', async () => {
  const calls: string[] = [];
  const template = definePdfTemplate({
    id: 'labels',
    summary: 'one label per row',
    page: { size: [200, 100], margin: 10 },
    options: { prefix: 'text in front of each label' },
    start(ctx) {
      calls.push('start');
      ctx.state.n = 0;
      ctx.doc.defaults.size = 10;
    },
    write(rows, ctx) {
      calls.push(`write ${rows.length}`);
      for (const r of rows) {
        ctx.state.n = (ctx.state.n as number) + 1;
        ctx.doc.paragraph(`${String(ctx.options.prefix ?? '')}${String(r.name)}`, { after: 0 });
      }
    },
    finish(ctx) {
      calls.push('finish');
      ctx.doc.paragraph(`${ctx.state.n} labels on ${ctx.date}`);
    },
  });
  const r = new PdfRenderer(template, { options: { prefix: '> ' }, date: new Date('2026-01-02T00:00:00Z') });
  await r.write([{ name: 'a' }, { name: 'b' }]);
  await r.write([]);
  await r.write([{ name: 'c' }]);
  const pdf = await r.finish();
  assert.deepEqual(calls, ['start', 'write 2', 'write 1', 'finish']);
  assert.equal(r.rows, 3);
  assert.deepEqual(lines(pdf, 1), ['> a', '> b', '> c', '3 labels on 2026-01-02']);
  assert.deepEqual(openPdf(pdf).pageSize(1), { width: 200, height: 100, rotate: 0 });
  assert.throws(() => new PdfRenderer(template, { options: { prefx: 'x' } }), /no option "prefx"/);
  await assert.rejects(r.finish(), /already finished/);
});

test('definePdfTemplate and validatePdfTemplate check the shape', () => {
  assert.throws(() => definePdfTemplate({ id: 'bad id', write: () => undefined }), /needs an id/);
  assert.throws(() => definePdfTemplate({ id: 'x' } as never), /needs write/);
  assert.equal(validatePdfTemplate({ id: 'x', write() {} }), null);
  assert.match(validatePdfTemplate({ id: 'x', write() {}, start: 1 }) ?? '', /start that is not a function/);
});

test('built-in templates reject an option they do not have, and say which they have', async () => {
  await assert.rejects(renderPdf([{ a: 1 }], 'table', { options: { zebr: true } }), (e: unknown) => e instanceof PdfError && /no option "zebr"/.test(e.message) && /zebra/.test(e.hint ?? ''));
  await assert.rejects(renderPdf([{ a: 1 }], 'table', { options: { size: 'huge' } }), /"size" of the table template must be a number/);
  await assert.rejects(renderPdf([{ a: 1 }], 'table', { options: { font: 'Wingdings' } }), /unknown font/);
  // options arriving as text from --option work
  const pdf = await renderPdf([{ a: 1 }], 'table', { options: { size: '12', zebra: 'false', pageNumbers: 'false' } });
  assert.equal(openPdf(pdf).items(1)[0]!.size, 12);
});

test('resolveTemplate: built-in id, layout file, saved name, and a helpful miss', () => {
  const home = tmp();
  const dir = path.join(home, 'pdf', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'weekly.json'), JSON.stringify({ ...starterLayout('weekly'), summary: 'the weekly one' }));
  fs.writeFileSync(path.join(dir, 'Not A Name.json'), '{}');
  fs.writeFileSync(path.join(home, 'mine.json'), JSON.stringify(starterLayout('mine')));
  fs.writeFileSync(path.join(home, 'broken.json'), '{"schema":1,"body":{"layout":"pie"}}');
  withHome(home, () => {
    assert.equal(resolveTemplate('table').id, 'table');
    assert.equal(resolveTemplate('weekly').id, 'weekly');
    assert.equal(resolveTemplate('weekly').summary, 'the weekly one');
    assert.deepEqual(listUserTemplates().map((t) => t.name), ['weekly']);
    assert.equal(resolveTemplate(path.join(home, 'mine.json')).id, 'mine');
    assert.equal(resolveTemplate('./mine.json', home).id, 'mine');
    assert.throws(() => resolveTemplate('./broken.json', home), /broken\.json is not a valid layout: body\.layout/);
    assert.throws(() => resolveTemplate('./missing.json', home), /does not exist/);
    assert.throws(() => resolveTemplate('../etc/passwd', home), /does not exist/);
    assert.throws(() => resolveTemplate('nothing'), (e: unknown) => e instanceof PdfError && /no PDF template "nothing"/.test(e.message) && /text, lines, table, records/.test(e.hint ?? '') && /saved: weekly/.test(e.hint ?? ''));
  });
  const mine = resolveTemplate({ id: 'inline', write() {} });
  assert.equal(mine.id, 'inline');
  assert.deepEqual(BUILTIN_TEMPLATES.map((t) => t.id), ['text', 'lines', 'table', 'records']);
});
