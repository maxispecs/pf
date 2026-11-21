import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { pdfCommand, parseOptionArg, parseRows } from '../src/commands/pdf.js';
import { openPdf } from '../src/read/extract.js';
import { validateLayout } from '../src/templates/json.js';
import { classicPdf, stream } from './builders.js';

const ctx = buildContext(os.tmpdir());
const dir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pdfcmd-'));

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => (typeof s === 'string' ? out.push(s) : so(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (typeof s === 'string' ? err.push(s) : se(s), true)) as typeof process.stderr.write;
  try {
    const code = await pdfCommand.run(ctx, args);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

function sample(d: string): string {
  const file = path.join(d, 'in.pdf');
  fs.writeFileSync(
    file,
    classicPdf(
      [
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
        [4, stream('', 'BT /F1 12 Tf 72 700 Td (Hello PDF) Tj 0 -14 Td (second) Tj ET')],
        [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
        [6, '<< /Title (Sample doc) /Author (Ada) >>'],
      ],
      '/Info 6 0 R',
    ),
  );
  return file;
}

function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PF_HOME;
  process.env.PF_HOME = home;
  return fn().finally(() => {
    if (saved === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = saved;
  });
}

test('pf pdf with no arguments prints the usage; an unknown subcommand is a usage error', async () => {
  const help = await run();
  assert.equal(help.code, 0);
  assert.match(help.stdout, /pf pdf write <out\.pdf>/);
  const bad = await run('nope');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown subcommand "nope"/);
});

test('info: text and --json', async () => {
  const file = sample(dir());
  const text = await run('info', file);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /pages\s+1/);
  assert.match(text.stdout, /612 x 792 pt/);
  assert.match(text.stdout, /title\s+Sample doc/);
  const json = JSON.parse((await run('info', file, '--json')).stdout);
  assert.equal(json.pages, 1);
  assert.equal(json.author, 'Ada');
  assert.deepEqual(json.pageSizes, [{ page: 1, width: 612, height: 792, rotate: 0 }]);
  const missing = await run('info', path.join(dir(), 'none.pdf'));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read/);
  assert.equal((await run('info')).code, 2);
});

test('text prints the text of the file; --pages narrows it', async () => {
  const file = sample(dir());
  assert.equal((await run('text', file)).stdout, 'Hello PDF\nsecond\n');
  assert.equal((await run('text', file, '--pages', '1')).stdout, 'Hello PDF\nsecond\n');
  const bad = await run('text', file, '--pages', '4');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /out of range/);
});

test('show: a table of lines, other extract modes, --limit, --json', async () => {
  const file = sample(dir());
  const t = await run('show', file);
  assert.match(t.stdout, /Hello PDF/);
  assert.match(t.stdout, /page/);
  const j = JSON.parse((await run('show', file, '--json', '--limit', '1')).stdout);
  assert.equal(j.length, 1);
  assert.match((await run('show', file, '--limit', '1')).stderr, /first 1 rows/);
  assert.match((await run('show', file, '--extract', 'pages')).stdout, /width/);
  assert.equal((await run('show', file, '--extract', 'fields')).stdout.includes('(no rows)'), true);
  assert.equal((await run('show', file, '--extract', 'zzz')).code, 2);
  assert.equal((await run('show', file, '--limit', '0')).code, 2);
  assert.equal((await run('show')).code, 2);
});

test('write: CSV to a PDF with a template and options; the file reads back', async () => {
  const d = dir();
  const csv = path.join(d, 'rows.csv');
  fs.writeFileSync(csv, 'id,name\n1,Ada\n2,"Grace, H."\n');
  const out = path.join(d, 'out.pdf');
  const r = await run('write', out, '--from', csv, '--option', 'title=People', '--option', 'pageNumbers=false', '--title', 'Doc', '--size', 'Letter');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /wrote .*out\.pdf \(2 rows, 1 page\)/);
  const f = openPdf(fs.readFileSync(out));
  assert.deepEqual(f.lines(1).map((l) => l.text), ['People', 'id name', '1 Ada', '2 Grace, H.']);
  assert.equal(f.info().title, 'Doc');
  assert.deepEqual(f.pageSize(1), { width: 612, height: 792, rotate: 0 });
  const again = await run('write', out, '--from', csv);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test('write: JSON and NDJSON rows, a layout file, --overwrite and --dry-run', async () => {
  const d = dir();
  const json = path.join(d, 'rows.json');
  fs.writeFileSync(json, JSON.stringify([{ text: 'one' }, { text: 'two' }]));
  const nd = path.join(d, 'rows.ndjson');
  fs.writeFileSync(nd, '{"text":"a"}\n\n{"text":"b"}\n');
  const out = path.join(d, 'o.pdf');
  assert.equal((await run('write', out, '--from', json, '--template', 'lines', '--option', 'pageNumbers=false')).code, 0);
  assert.deepEqual(openPdf(fs.readFileSync(out)).lines(1).map((l) => l.text), ['one', 'two']);

  const dry = await run('write', out, '--from', nd, '--template', 'lines', '--overwrite', '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.stderr, /would replace .*o\.pdf with a PDF \(2 rows, 1 page\)/);
  assert.equal(openPdf(fs.readFileSync(out)).lines(1)[0]!.text, 'one');

  const needsYes = await run('write', out, '--from', nd, '--template', 'lines', '--overwrite');
  assert.equal(needsYes.code, 1, 'no terminal: --yes is needed to replace');
  assert.equal(openPdf(fs.readFileSync(out)).lines(1)[0]!.text, 'one');
  const yes = await run('write', out, '--from', nd, '--template', 'lines', '--overwrite', '--yes', '--option', 'pageNumbers=false');
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual(openPdf(fs.readFileSync(out)).lines(1).map((l) => l.text), ['a', 'b']);

  const layout = path.join(d, 'layout.json');
  fs.writeFileSync(layout, JSON.stringify({ schema: 1, body: { each: [{ type: 'text', text: 'Row: {{text}}' }] } }));
  const out2 = path.join(d, 'o2.pdf');
  assert.equal((await run('write', out2, '--from', json, '--template', layout)).code, 0);
  assert.deepEqual(openPdf(fs.readFileSync(out2)).lines(1).map((l) => l.text), ['Row: one', 'Row: two']);
});

test('write: usage and input errors', async () => {
  const d = dir();
  const out = path.join(d, 'o.pdf');
  const bad = path.join(d, 'bad.csv');
  fs.writeFileSync(bad, 'a,b\n1\n');
  assert.equal((await run('write')).code, 2);
  assert.equal((await run('write', out)).code, 2);
  assert.match((await run('write', out, '--from', 'rows.txt')).stderr, /cannot tell the format/);
  assert.match((await run('write', out, '--from', bad, '--format', 'xml')).stderr, /--format must be one of/);
  assert.match((await run('write', out, '--from', bad, '--size', 'B7')).stderr, /--size must be one of/);
  assert.match((await run('write', out, '--from', bad, '--orientation', 'tilted')).stderr, /--orientation/);
  assert.match((await run('write', out, '--from', bad, '--option', 'oops')).stderr, /write it as name=value/);
  const r = await run('write', out, '--from', bad);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /record 2 has 1 values, expected 2/);
  const nope = await run('write', out, '--from', path.join(d, 'none.csv'));
  assert.equal(nope.code, 1);
  assert.match(nope.stderr, /cannot read/);
  const good = path.join(d, 'good.csv');
  fs.writeFileSync(good, 'a\n1\n');
  const tpl = await run('write', out, '--from', good, '--template', 'nothing');
  assert.equal(tpl.code, 1);
  assert.match(tpl.stderr, /no PDF template "nothing"/);
  assert.match(tpl.stderr, /built in: text, lines, table, records/);
  assert.equal(fs.existsSync(out), false);
});

test('templates lists the built-in and saved layouts; templates new writes a valid starter once', async () => {
  const home = dir();
  await withHome(home, async () => {
    const list = await run('templates');
    assert.equal(list.code, 0);
    for (const id of ['text', 'lines', 'table', 'records']) assert.match(list.stdout, new RegExp(id));
    const made = await run('templates', 'new', 'weekly');
    assert.equal(made.code, 0, made.stderr);
    const file = path.join(home, 'pdf', 'templates', 'weekly.json');
    assert.equal(typeof validateLayout(JSON.parse(fs.readFileSync(file, 'utf8'))), 'object');
    const json = JSON.parse((await run('templates', '--json')).stdout);
    assert.deepEqual(json.saved.map((s: { name: string }) => s.name), ['weekly']);
    assert.deepEqual(json.builtin.map((s: { id: string }) => s.id), ['text', 'lines', 'table', 'records']);
    assert.match((await run('templates')).stdout, /weekly/);
    const twice = await run('templates', 'new', 'weekly');
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /already exists/);
    assert.equal((await run('templates', 'new', 'table')).code, 2);
    assert.equal((await run('templates', 'new', 'bad name')).code, 2);
    const dry = await run('templates', 'new', 'other', '--dry-run');
    assert.match(dry.stderr, /would write .*other\.json/);
    assert.equal(fs.existsSync(path.join(home, 'pdf', 'templates', 'other.json')), false);
    const csv = path.join(home, 'r.csv');
    fs.writeFileSync(csv, 'id,name\n1,Ada\n');
    const out = path.join(home, 'weekly.pdf');
    const used = await run('write', out, '--from', csv, '--template', 'weekly', '--option', 'title=Weekly', '--option', 'company=Acme');
    assert.equal(used.code, 0, used.stderr);
    assert.ok(openPdf(fs.readFileSync(out)).lines(1).some((l) => l.text === 'Weekly'));
    const elsewhere = await run('templates', 'new', 'there', '--dir', path.join(home, 'x'));
    assert.equal(elsewhere.code, 0);
    assert.ok(fs.existsSync(path.join(home, 'x', 'there.json')));
  });
});

test('option and row parsing helpers', () => {
  assert.deepEqual(parseOptionArg('size=10'), ['size', 10]);
  assert.deepEqual(parseOptionArg('zebra=false'), ['zebra', false]);
  assert.deepEqual(parseOptionArg('columns=["a","b"]'), ['columns', ['a', 'b']]);
  assert.deepEqual(parseOptionArg('columns=a,b'), ['columns', 'a,b']);
  assert.deepEqual(parseOptionArg('title=2026 report'), ['title', '2026 report']);
  assert.deepEqual(parseOptionArg('title={oops'), ['title', '{oops']);
  assert.throws(() => parseOptionArg('=x'), /name=value/);
  assert.throws(() => parseOptionArg('bad key=1'), /not a valid option name/);
  assert.deepEqual(parseRows('a,b\r\n1,"x\ny"\r\n\r\n', 'csv', 'f'), [{ a: '1', b: 'x\ny' }]);
  assert.deepEqual(parseRows('', 'csv', 'f'), []);
  assert.throws(() => parseRows('a,a\n1,2', 'csv', 'f'), /distinct name/);
  assert.throws(() => parseRows('{"a":1}', 'json', 'f'), /list of objects/);
  assert.throws(() => parseRows('[1]', 'json', 'f'), /item 1 is not an object/);
  assert.throws(() => parseRows('{"a":1}\nnope', 'ndjson', 'f'), /not valid NDJSON/);
});
