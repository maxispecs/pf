import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { MAC_ROMAN_80, baseEncoding, glyphToUnicode, winAnsiByte } from '../src/encodings.js';
import { PdfError } from '../src/errors.js';
import { ASCII_WIDTHS, charWidth, parseFont, stringWidth } from '../src/metrics.js';
import { applyFilters } from '../src/read/filters.js';
import { Lexer, Name, PdfString, Ref, type Dict } from '../src/read/lexer.js';
import { decodeTextString, openPdf, parsePageRange, parsePdfDate } from '../src/read/extract.js';
import { classicPdf, modernPdf, onePage, stream } from './builders.js';

const HELLO = 'BT /F1 12 Tf 72 700 Td (Hello World) Tj 0 -14 Td (Second line) Tj ET';

test('a classic cross-reference file gives its lines with positions', () => {
  const pdf = openPdf(onePage(HELLO));
  assert.equal(pdf.pageCount, 1);
  assert.equal(pdf.version, '1.4');
  assert.deepEqual(pdf.pageSize(1), { width: 612, height: 792, rotate: 0 });
  const lines = pdf.lines(1);
  assert.deepEqual(lines.map((l) => l.text), ['Hello World', 'Second line']);
  assert.equal(lines[0]!.y, 700);
  assert.equal(lines[1]!.y, 686);
  assert.equal(lines[0]!.x, 72);
  assert.equal(pdf.text(1), 'Hello World\nSecond line');
});

test('an xref stream with an object stream and compressed content reads the same way', () => {
  const pdf = openPdf(modernPdf(HELLO));
  assert.equal(pdf.version, '1.5');
  assert.equal(pdf.pageCount, 1);
  assert.deepEqual(pdf.pageSize(1), { width: 300, height: 400, rotate: 0 });
  assert.equal(pdf.text(1), 'Hello World\nSecond line');
});

test('compressed content streams decode', () => {
  assert.equal(openPdf(onePage(HELLO, { compress: true })).text(1), 'Hello World\nSecond line');
});

test('Flate with a PNG predictor decodes (Up rows)', () => {
  const plain = Buffer.from('BT /F1 12 Tf 10 10 Td (Predicted) Tj ET');
  const rows: number[] = [];
  let prev = 0;
  for (const b of plain) {
    rows.push(2, (b - prev + 256) & 0xff); // filter type Up, one byte per row
    prev = b;
  }
  const raw = zlib.deflateSync(Buffer.from(rows));
  const content = Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 1 >> /Length ${raw.length} >>\nstream\n`), raw, Buffer.from('\nendstream')]);
  const pdf = openPdf(
    classicPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
      [4, content],
      [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    ]),
  );
  assert.equal(pdf.text(1), 'Predicted');
});

test('the other filters: ASCIIHex, ASCII85, RunLength and LZW', () => {
  const dict = (f: string): Dict => new Map([['Filter', new Name(f)]]);
  const id = (o: unknown) => o as never;
  assert.equal(applyFilters(Buffer.from('48 65 6C6c 6F>'), dict('ASCIIHexDecode'), id).toString(), 'Hello');
  assert.equal(applyFilters(Buffer.from('87cURD]i,"Ebo80~>'), dict('ASCII85Decode'), id).toString(), 'Hello World!');
  assert.equal(applyFilters(Buffer.from([2, 65, 66, 67, 254, 68, 128]), dict('RunLengthDecode'), id).toString(), 'ABCDDD');
  // LZW of "-----A---B" from the PDF reference: 80 0B 60 50 22 0C 0C 85 01
  assert.equal(applyFilters(Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]), dict('LZWDecode'), id).toString(), '-----A---B');
  assert.throws(() => applyFilters(Buffer.from('x'), dict('DCTDecode'), id), /not supported/);
});

test('Type0 text: ToUnicode with bfchar and bfrange, and CID widths place the next run', () => {
  const cmap = 'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0001> <0048> endbfchar 1 beginbfrange <0002> <0004> <0069> endbfrange endcmap';
  const bytes = onePage('BT /F2 10 Tf 50 100 Td <0001000200030004> Tj ET', {
    fonts: '/F1 5 0 R /F2 6 0 R',
    extra: [
      [6, '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Some /Encoding /Identity-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /DW 500 /W [1 [600] 2 4 400] >>] /ToUnicode 7 0 R >>'],
      [7, stream('', cmap)],
    ],
  });
  const items = openPdf(bytes).items(1);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.text, 'Hijk');
  assert.equal(items[0]!.font, 'Some');
  // widths 600 + 400 + 400 + 400 = 1800/1000 * 10
  assert.ok(Math.abs(items[0]!.width - 18) < 1e-9);
});

test('/Differences and the other base encodings', () => {
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /Euro /fi 97 /uni0042] >> >>';
  assert.equal(openPdf(onePage('BT /F1 12 Tf 10 10 Td (ABa) Tj ET', { font })).text(1), '€ﬁB');
  const mac = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /MacRomanEncoding >>';
  assert.equal(openPdf(onePage('BT /F1 12 Tf 10 10 Td (caf\\216) Tj ET', { font: mac })).text(1), 'café');
});

test('TJ kerning gaps become spaces, small ones do not', () => {
  const pdf = openPdf(onePage('BT /F1 12 Tf 10 10 Td [(Hel) -20 (lo) -600 (World)] TJ ET'));
  assert.equal(pdf.text(1), 'Hello World');
});

test('items on one baseline join in x order; a lower baseline is another line', () => {
  const pdf = openPdf(onePage('BT /F1 12 Tf 200 100 Td (right) Tj ET BT /F1 12 Tf 100 100 Td (left) Tj ET BT /F1 12 Tf 100 80 Td (below) Tj ET'));
  assert.deepEqual(pdf.lines(1).map((l) => l.text), ['left right', 'below']);
});

test('form XObjects are followed, with their matrix', () => {
  const form = stream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 100 200] /Resources << /Font << /F1 5 0 R >> >>', 'BT /F1 10 Tf 5 5 Td (In form) Tj ET');
  const pdf = openPdf(onePage('q 1 0 0 1 10 10 cm /Fm1 Do Q BT /F1 10 Tf 0 0 Td (Outside) Tj ET', { resources: '/XObject << /Fm1 6 0 R >>', extra: [[6, form]] }));
  const items = pdf.items(1);
  const inForm = items.find((i) => i.text === 'In form')!;
  assert.equal(inForm.x, 115);
  assert.equal(inForm.y, 215);
  assert.ok(items.some((i) => i.text === 'Outside'));
});

test('a form that includes itself does not loop', () => {
  const form = stream('/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Fm1 6 0 R >> /Font << /F1 5 0 R >> >>', 'BT /F1 10 Tf (x) Tj ET /Fm1 Do');
  const pdf = openPdf(onePage('/Fm1 Do', { resources: '/XObject << /Fm1 6 0 R >>', extra: [[6, form]] }));
  assert.equal(pdf.items(1).length, 1);
});

test('a broken startxref or xref table is rebuilt by scanning', () => {
  const good = onePage(HELLO);
  const badStart = Buffer.from(good.toString('latin1').replace(/startxref\n\d+/, 'startxref\n7'), 'latin1');
  assert.equal(openPdf(badStart).text(1), 'Hello World\nSecond line');
  const noTail = good.subarray(0, good.indexOf('xref\n0 '));
  assert.equal(openPdf(noTail).text(1), 'Hello World\nSecond line');
  const wrongOffsets = Buffer.from(good.toString('latin1').replace(/(\d{10}) 00000 n/g, '0000000099 00000 n'), 'latin1');
  assert.equal(openPdf(wrongOffsets).text(1), 'Hello World\nSecond line');
});

test('a stream with a wrong /Length is still found by its endstream', () => {
  const body = Buffer.from(`<< /Length 5 >>\nstream\n${HELLO}\nendstream`, 'latin1');
  const pdf = openPdf(
    classicPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
      [4, body],
      [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    ]),
  );
  assert.equal(pdf.text(1), 'Hello World\nSecond line');
});

test('what is not a PDF, and an encrypted PDF, are refused with a clear error', () => {
  assert.throws(() => openPdf(Buffer.from('hello')), (e: unknown) => e instanceof PdfError && /not a PDF/.test(e.message));
  assert.throws(() => openPdf(onePage(HELLO, { trailerExtra: '/Encrypt 9 0 R', extra: [[9, '<< /Filter /Standard /V 1 /R 2 >>']] })), (e: unknown) => e instanceof PdfError && /encrypted/.test(e.message) && !!e.hint);
});

test('metadata, dates and text strings', () => {
  const title = '<FEFF00480065006C006C006F0020D83DDE00>'; // "Hello 😀" in UTF-16BE
  const pdf = openPdf(
    onePage(HELLO, {
      trailerExtra: '/Info 6 0 R',
      extra: [[6, `<< /Title ${title} /Author (Ada \\(Lovelace\\)) /CreationDate (D:20260115103000+01'00') /ModDate (D:20260116) /Keywords (a, b) >>`]],
    }),
  );
  assert.deepEqual(pdf.info(), { title: 'Hello 😀', author: 'Ada (Lovelace)', keywords: 'a, b', created: '2026-01-15T09:30:00.000Z', modified: '2026-01-16T00:00:00.000Z' });
  assert.equal(parsePdfDate('D:2026'), '2026-01-01T00:00:00.000Z');
  assert.equal(parsePdfDate('yesterday'), 'yesterday');
  assert.equal(decodeTextString(Buffer.from([0x80, 0x41, 0xa0])), '•A€');
  assert.equal(decodeTextString(Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9])), 'é');
});

test('page tree: inherited resources and boxes, rotation, nested kids, ranges', () => {
  const pdf = openPdf(
    classicPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> >>'],
      [3, '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 /Rotate 90 >>'],
      [4, '<< /Type /Page /Parent 3 0 R /Contents 7 0 R >>'],
      [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
      [6, '<< /Type /Page /Parent 2 0 R /Contents 7 0 R /CropBox [0 0 50 60] >>'],
      [7, stream('', 'BT /F1 10 Tf 5 5 Td (inherits) Tj ET')],
    ]),
  );
  assert.equal(pdf.pageCount, 2);
  assert.deepEqual(pdf.pageSize(1), { width: 100, height: 200, rotate: 90 });
  assert.deepEqual(pdf.pageSize(2), { width: 50, height: 60, rotate: 0 });
  assert.equal(pdf.text(1), 'inherits');
  assert.throws(() => pdf.pageSize(3), /no page 3/);
  assert.deepEqual(parsePageRange('1-3,5', 9), [1, 2, 3, 5]);
  assert.deepEqual(parsePageRange('4-', 6), [4, 5, 6]);
  assert.deepEqual(parsePageRange('2,2,1', 3), [1, 2]);
  assert.throws(() => parsePageRange('x', 3), /not a page/);
  assert.throws(() => parsePageRange('4', 3), /out of range/);
  assert.throws(() => parsePageRange('3-1', 3), /valid page range/);
});

test('form fields: names, types and values', () => {
  const pdf = openPdf(
    onePage(HELLO, {
      catalogExtra: '/AcroForm << /Fields [6 0 R 7 0 R 9 0 R] >>',
      extra: [
        [6, '<< /FT /Tx /T (name) /V (Ada) >>'],
        [7, '<< /T (address) /Kids [8 0 R] >>'],
        [8, '<< /FT /Tx /T (city) /V <FEFF00560069> >>'],
        [9, '<< /FT /Btn /T (agree) /V /Yes /Ff 0 >>'],
      ],
    }),
  );
  assert.deepEqual(pdf.fields(), [
    { name: 'name', type: 'text', value: 'Ada' },
    { name: 'address.city', type: 'text', value: 'Vi' },
    { name: 'agree', type: 'checkbox', value: 'Yes' },
  ]);
});

test('the lexer: strings, names, references, nesting and inline images', () => {
  const lx = new Lexer(Buffer.from('<< /A#20B (a\\(b\\)\\101\\n) /R 3 0 R /H <48656C6C6F7> /N [1 -2.5 .5 true null] >> % comment\n12'));
  const d = lx.next() as Dict;
  assert.equal((d.get('A B') as PdfString).bytes.toString(), 'a(b)A\n');
  assert.deepEqual(d.get('R'), new Ref(3, 0));
  assert.equal((d.get('H') as PdfString).bytes.toString('latin1'), 'Hellop');
  assert.deepEqual(d.get('N'), [1, -2.5, 0.5, true, null]);
  assert.equal(lx.next(), 12);
  assert.throws(() => lx.next(), /unexpected end/);
  const image = new Lexer(Buffer.from('BI /W 1 /H 1 ID \x01\x02 EI Q'), 3, false);
  image.skipInlineImage();
  assert.equal((image.next() as { op: string }).op, 'Q');
});

test('encodings and metrics tables are complete', () => {
  assert.equal([...MAC_ROMAN_80].length, 128);
  assert.equal(baseEncoding('WinAnsiEncoding')[0x93], '“');
  assert.equal(baseEncoding('StandardEncoding')[0x27], '’');
  assert.equal(baseEncoding('MacRomanEncoding')[0xe8], 'Ë');
  assert.equal(winAnsiByte('é'), 0xe9);
  assert.equal(winAnsiByte('€'), 0x80);
  assert.equal(winAnsiByte('日'), null);
  assert.equal(glyphToUnicode('eacute'), 'é');
  assert.equal(glyphToUnicode('f_i'), 'fi');
  assert.equal(glyphToUnicode('a.alt'), 'a');
  assert.equal(glyphToUnicode('u1F600'), '😀');
  assert.equal(glyphToUnicode('.notdef'), '');
  for (const [name, w] of Object.entries(ASCII_WIDTHS)) assert.equal(w.length, 95, name);
  assert.equal(charWidth('Helvetica', 'A'), 667);
  assert.equal(charWidth('Helvetica-Oblique', 'A'), 667);
  assert.equal(charWidth('Helvetica', 'é'), 556);
  assert.equal(charWidth('Courier-Bold', 'W'), 600);
  assert.equal(stringWidth('Times-Roman', 'Hello', 10), (722 + 444 + 278 + 278 + 500) / 100);
  assert.equal(parseFont('sans-serif'), 'Helvetica');
  assert.equal(parseFont('Times-BoldItalic'), 'Times-BoldItalic');
  assert.equal(parseFont('ABCDEF+Arial-BoldMT'), 'Helvetica-Bold');
  assert.equal(parseFont('mono', true), 'Courier-Bold');
  assert.equal(parseFont('Comic Sans'), 'Helvetica');
  assert.equal(parseFont('Wingdings'), null);
});
