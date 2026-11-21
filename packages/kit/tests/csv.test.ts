import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CsvParser, cellText, checkDelimiter, columnsOf, csvCell, encodeCsvLine, parseCsv, toCsv } from '../src/csv.js';

test('encoding quotes what needs it', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('a;b', ';'), '"a;b"');
  assert.equal(csvCell('a,b', ';'), 'a,b');
  assert.equal(encodeCsvLine(['a', 'b c', 'd,e']), 'a,b c,"d,e"');
});

test('toCsv writes a header and the cells as text', () => {
  const rows = [{ id: 1, name: 'Ann', at: new Date('2026-01-02T03:04:05Z'), big: 10n, nil: null }, { id: 2, extra: { a: 1 } }];
  assert.equal(
    toCsv(rows),
    ['id,name,at,big,nil,extra', '1,Ann,2026-01-02T03:04:05.000Z,10,,', '2,,,,,"{""a"":1}"'].join('\n'),
  );
  assert.equal(toCsv(rows, { columns: ['name', 'id'], header: false }), 'Ann,1\n,2');
  assert.equal(toCsv([{ a: 1, b: 2 }], { delimiter: ';' }), 'a;b\n1;2');
  assert.equal(toCsv([]), '');
  assert.equal(toCsv([], { columns: ['a', 'b'] }), 'a,b');
});

test('cellText and columnsOf', () => {
  assert.equal(cellText(undefined), '');
  assert.equal(cellText(new Date('nope')), '');
  assert.equal(cellText(new Uint8Array(3)), '<3 bytes>');
  assert.equal(cellText(true), 'true');
  assert.deepEqual(columnsOf([{ a: 1 }, { b: 2, a: 3 }]), ['a', 'b']);
});

test('a delimiter is one plain character', () => {
  assert.equal(checkDelimiter(','), null);
  assert.equal(checkDelimiter('\t'), null);
  assert.ok(checkDelimiter(''));
  assert.ok(checkDelimiter('ab'));
  assert.ok(checkDelimiter('"'));
  assert.ok(checkDelimiter('\n'));
  assert.throws(() => new CsvParser('"'), /delimiter/);
});

test('parsing handles quotes, doubled quotes and line breaks inside values', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('"a,b","say ""hi""","two\nlines"\n'), [['a,b', 'say "hi"', 'two\nlines']]);
  assert.deepEqual(parseCsv('a,,c\n,\n'), [['a', '', 'c'], ['', '']]);
  assert.deepEqual(parseCsv('x;y\n1;2', ';'), [['x', 'y'], ['1', '2']]);
  assert.deepEqual(parseCsv('5" pipe,ok\n'), [['5" pipe', 'ok']]);
  assert.deepEqual(parseCsv('""\n'), [['']]);
});

test('parsing accepts CRLF, CR, a missing last line break, blank lines and a BOM', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\r1\r'), [['a'], ['1']]);
  assert.deepEqual(parseCsv('a\n\n\n1'), [['a'], ['1']]);
  assert.deepEqual(parseCsv('\uFEFFid,name\n1,x\n'), [['id', 'name'], ['1', 'x']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('"a\r\nb"\r\n'), [['a\r\nb']]);
});

test('an unclosed quote is an error', () => {
  assert.throws(() => parseCsv('a,"b\n'), /quote/);
});

test('parsing gives the same records however the text is cut', () => {
  const text = '\uFEFFid,note\r\n1,"a ""b"", c\r\nd"\r\n2,\r\n\r\n3,plain';
  const whole = parseCsv(text);
  assert.deepEqual(whole, [['id', 'note'], ['1', 'a "b", c\r\nd'], ['2', ''], ['3', 'plain']]);
  for (let size = 1; size <= text.length; size++) {
    const p = new CsvParser();
    const got: string[][] = [];
    for (let i = 0; i < text.length; i += size) got.push(...p.push(text.slice(i, i + size)));
    got.push(...p.end());
    assert.deepEqual(got, whole, `chunks of ${size}`);
  }
});

test('what toCsv writes parses back', () => {
  const rows = [{ a: 'x,y', b: 'q"r', c: 'l1\nl2', d: '' }];
  const back = parseCsv(toCsv(rows));
  assert.deepEqual(back, [['a', 'b', 'c', 'd'], ['x,y', 'q"r', 'l1\nl2', '']]);
});
