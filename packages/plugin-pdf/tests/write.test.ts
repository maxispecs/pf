import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PdfError } from '../src/errors.js';
import { openPdf } from '../src/read/extract.js';
import { PdfRenderer, renderPdf } from '../src/templates/render.js';
import { PdfDoc, fitWidths, parseColor } from '../src/write/doc.js';

const lines = (pdf: Buffer, page: number): string[] => openPdf(pdf).lines(page).map((l) => l.text);

test('the table template: header, rows, numbers on the right, page numbers', async () => {
  const pdf = await renderPdf(
    [
      { id: 1, name: 'Ada', score: 9.5 },
      { id: 2, name: 'Grace', score: 10 },
    ],
    'table',
    { title: 'x', options: { title: 'Scores' } },
  );
  assert.deepEqual(lines(pdf, 1), ['Scores', 'id name score', '1 Ada 9.5', '2 Grace 10', 'Page 1 of 1']);
  const f = openPdf(pdf);
  assert.equal(f.version, '1.4');
  assert.deepEqual(f.pageSize(1), { width: 595.28, height: 841.89, rotate: 0 });
  const items = f.items(1);
  const score = items.find((i) => i.text === '9.5')!;
  const head = items.find((i) => i.text === 'score')!;
  assert.ok(Math.abs(score.x + score.width - (head.x + head.width)) < 0.01, 'numbers align right with their header');
});

test('a long table runs over pages and repeats its header', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `name ${i + 1}` }));
  const pdf = await renderPdf(rows, 'table');
  const f = openPdf(pdf);
  assert.ok(f.pageCount >= 3, `pages: ${f.pageCount}`);
  for (let p = 1; p <= f.pageCount; p++) {
    assert.equal(f.lines(p)[0]!.text, 'id name', `page ${p}`);
    assert.equal(f.lines(p).at(-1)!.text, `Page ${p} of ${f.pageCount}`);
  }
  const all = Array.from({ length: f.pageCount }, (_, i) => f.lines(i + 1)).flat().filter((l) => /^\d+ name \d+$/.test(l.text));
  assert.equal(all.length, 200);
  assert.equal(all[199]!.text, '200 name 200');
});

test('table columns: a subset in the given order, with titles, widths and alignment', async () => {
  const pdf = await renderPdf([{ a: 'x', b: 'y', c: 'z' }], 'table', {
    options: { columns: [{ key: 'c', title: 'See', width: 100, align: 'right' }, 'a'], pageNumbers: false },
  });
  assert.deepEqual(lines(pdf, 1), ['See a', 'z x']);
});

test('a row with a column the first rows lacked is an error when the columns were inferred', async () => {
  const r = new PdfRenderer('table');
  await r.write([{ a: 1 }]);
  await assert.rejects(r.write([{ a: 2, b: 3 }]), /column "b"/);
});

test('the text template wraps paragraphs inside the margins and keeps line breaks', async () => {
  const long = 'lorem ipsum dolor sit amet '.repeat(30).trim();
  const pdf = await renderPdf([{ text: long }, { text: 'one\ntwo' }], 'text', { options: { pageNumbers: false } });
  const f = openPdf(pdf);
  const items = f.items(1);
  assert.ok(f.lines(1).length > 4);
  for (const i of items) assert.ok(i.x + i.width <= 595.28 - 54 + 0.5, `${i.text} ends at ${i.x + i.width}`);
  assert.deepEqual(f.lines(1).slice(-2).map((l) => l.text), ['one', 'two']);
  assert.equal(f.lines(1).map((l) => l.text).join(' ').startsWith('lorem ipsum'), true);
});

test('the text template reads the one column the rows have, or says which to pick', async () => {
  assert.deepEqual(lines(await renderPdf([{ body: 'hi' }], 'text', { options: { pageNumbers: false } }), 1), ['hi']);
  await assert.rejects(renderPdf([{ a: 'x', b: 'y' }], 'text'), (e: unknown) => e instanceof PdfError && /which column/.test(e.message) && /a, b/.test(e.hint ?? ''));
  await assert.rejects(renderPdf([{ a: 'x' }], 'text', { options: { field: 'zzz' } }), /no column "zzz"/);
});

test('the lines template: a list value is many lines, numbers continue across batches, long lines continue', async () => {
  const r = new PdfRenderer('lines', { options: { lineNumbers: true, pageNumbers: false } });
  await r.write([{ text: ['first', 'second'] }]);
  await r.write([{ text: 'third' }, { text: 'x'.repeat(200) }]);
  const out = lines(await r.finish(), 1);
  assert.deepEqual(out.slice(0, 3), ['1 first', '2 second', '3 third']);
  assert.ok(out[3]!.startsWith('4 xxx'));
  assert.ok(out.length > 5, 'the long line continued');
  assert.ok(!out.slice(5).some((l) => /^\d/.test(l)), 'the continuation has no number');
});

test('the records template prints label and value blocks with an optional title', async () => {
  const pdf = await renderPdf([{ name: 'Ada', city: 'London' }], 'records', { options: { titleField: 'name', pageNumbers: false } });
  assert.deepEqual(lines(pdf, 1), ['Ada', 'city London']);
});

test('characters outside WinAnsi become ? and are counted; WinAnsi extras survive', async () => {
  const r = new PdfRenderer('text', { options: { pageNumbers: false } });
  await r.write([{ text: 'Zoë 日本 € — “q” © (a) \\ b' }]);
  const pdf = await r.finish();
  assert.equal(r.replaced, 2);
  assert.deepEqual(lines(pdf, 1), ['Zoë ?? € — “q” © (a) \\ b']);
});

test('metadata, including a title that is not ASCII', async () => {
  const pdf = await renderPdf([{ a: 1 }], 'table', { title: 'Zoë — report', author: 'Ada', subject: 'S', keywords: 'k1, k2', date: new Date('2026-03-04T05:06:07Z') });
  assert.deepEqual(openPdf(pdf).info(), {
    title: 'Zoë — report', author: 'Ada', subject: 'S', keywords: 'k1, k2', creator: 'pf', producer: 'pf pdf', created: '2026-03-04T05:06:07.000Z',
  });
});

test('page setup: landscape, a custom size, margins; and a bad one is an error', async () => {
  const land = openPdf(await renderPdf([{ a: 1 }], 'table', { page: { size: 'Letter', orientation: 'landscape' } }));
  assert.deepEqual(land.pageSize(1), { width: 792, height: 612, rotate: 0 });
  const custom = openPdf(await renderPdf([{ a: 1 }], 'table', { page: { size: [300, 200], margin: 20 } }));
  assert.deepEqual(custom.pageSize(1), { width: 300, height: 200, rotate: 0 });
  assert.throws(() => new PdfDoc({ size: 'B7' as 'A4' }), /unknown page size/);
  assert.throws(() => new PdfDoc({ size: [100, 100], margin: 60 }), /no room/);
});

test('PdfDoc: wrap breaks at spaces and inside a word that is too long; onEachPage knows the count', () => {
  const doc = new PdfDoc({ size: [200, 200], margin: 20 });
  const w = doc.wrap('aaa bbb ccc ddd', doc.textWidth('aaa bbb'), { size: 10 });
  assert.deepEqual(w, ['aaa bbb', 'ccc ddd']);
  const long = doc.wrap('x'.repeat(100), 60, { size: 10 });
  assert.ok(long.length > 1 && long.every((l) => doc.textWidth(l, { size: 10 }) <= 60.01));
  assert.equal(long.join(''), 'x'.repeat(100));
  assert.deepEqual(doc.wrap('a\n\nb', 100), ['a', '', 'b']);
  doc.paragraph('p '.repeat(400));
  doc.onEachPage((d, p, n) => d.text(`${p}/${n}`, { x: 10, y: 5 }));
  const pdf = openPdf(doc.finish());
  assert.ok(pdf.pageCount > 2);
  assert.ok(pdf.lines(1).some((l) => l.text === `1/${pdf.pageCount}`));
  assert.ok(pdf.lines(pdf.pageCount).some((l) => l.text === `${pdf.pageCount}/${pdf.pageCount}`));
});

test('PdfDoc: fonts, colors and low level drawing', () => {
  const doc = new PdfDoc();
  assert.throws(() => doc.text('x', { x: 1, y: 1, font: 'Wingdings' }), /unknown font/);
  assert.throws(() => parseColor('nope'), /not a color/);
  assert.throws(() => parseColor(2), /not a color/);
  assert.deepEqual(parseColor('#f00'), [1, 0, 0]);
  assert.deepEqual(parseColor('gray'), [0.5, 0.5, 0.5]);
  doc.text('Bold serif', { x: 72, y: 700, font: 'serif', bold: true, size: 20, color: '#336699' });
  doc.text('Right', { x: 300, y: 600, align: 'right' });
  doc.line(10, 10, 100, 10);
  doc.rect(10, 20, 50, 20, { fill: '#eeeeee', stroke: 'black' });
  const f = openPdf(doc.finish());
  const items = f.items(1);
  assert.equal(items[0]!.font, 'Times-Bold');
  assert.equal(items[0]!.size, 20);
  const right = items.find((i) => i.text === 'Right')!;
  assert.ok(Math.abs(right.x + right.width - 300) < 0.01);
});

test('fitWidths keeps small columns and shrinks the large ones', () => {
  assert.deepEqual(fitWidths([null, null], [50, 80], 500, 10), [50, 80]);
  const fit = fitWidths([null, null, null], [50, 400, 400], 500, 10);
  assert.equal(fit[0], 50);
  assert.ok(Math.abs(fit[1]! - 225) < 1e-9 && Math.abs(fit[2]! - 225) < 1e-9);
  assert.deepEqual(fitWidths([100, null], [0, 900], 300, 10), [100, 200]);
});

test('an empty table says so, and a PDF with no content is still a valid file', async () => {
  assert.deepEqual(lines(await renderPdf([], 'table', { options: { pageNumbers: false } }), 1), ['(no rows)']);
  const blank = openPdf(await renderPdf([], 'text'));
  assert.equal(blank.pageCount, 1);
});
