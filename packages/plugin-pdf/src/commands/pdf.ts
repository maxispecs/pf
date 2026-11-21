import fs from 'node:fs';
import path from 'node:path';
import { cellText, columnsOf, parseCsv } from '@pulpfixer/kit/csv';
import type { Context } from '@pulpfixer/kit/context';
import type { IoContext, Row } from '@pulpfixer/kit/io';
import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { badge, table, termLine } from '@pulpfixer/kit/ui/text';
import { takeFlag, takeOption } from '@pulpfixer/kit/util';
import { EXTRACT_MODES, pdfAdapter, type ExtractMode, type PdfSinkConfig, type PdfSourceConfig } from '../adapter.js';
import { PdfError } from '../errors.js';
import { openPdf } from '../read/extract.js';
import { PAGE_SIZES, type PageSetup } from '../write/doc.js';
import { BUILTIN_TEMPLATES } from '../templates/builtin.js';
import { LAYOUT_SCHEMA, parseLayoutText, starterLayout } from '../templates/json.js';
import { listUserTemplates, userTemplateDir } from '../templates/resolve.js';

const say = (s: string): void => void process.stderr.write(s + '\n');

const USAGE = [
  'pf pdf info <file> [--json]',
  'pf pdf text <file> [--pages 1-3]',
  'pf pdf show <file> [--extract lines|pages|items|fields|meta] [--pages 1-3] [--limit <n>] [--json]',
  'pf pdf write <out.pdf> --from <rows.csv|rows.json|rows.ndjson|-> [--template <id|file.json|name>] [--option k=v ...] [--title t] [--size A4] [--orientation landscape] [--format csv|json|ndjson] [--overwrite] [--dry-run] [--yes]',
  'pf pdf templates [--json]',
  'pf pdf templates new <name> [--dir <folder>] [--dry-run]',
];
const USAGE_BY_SUB: Record<string, string> = { info: USAGE[0]!, text: USAGE[1]!, show: USAGE[2]!, write: USAGE[3]!, templates: USAGE[4]! };

const usageError = (msg: string, usage = USAGE[0]!): number => {
  const c = err();
  say(`${badge.error(msg, c)}\n  ${c.dim('usage')} ${termLine(usage, c)}`);
  return 2;
};

function fail(e: unknown, what: string): number {
  const c = err();
  if (e instanceof PdfError) {
    say(badge.error(e.message, c));
    if (e.hint) say(`  ${c.dim(e.hint)}`);
  } else say(badge.error(`pdf ${what} failed: ${e instanceof Error ? e.message : String(e)}`, c));
  return 1;
}

const ioFor = (ctx: Context, over: Partial<IoContext> = {}): IoContext => ({ ctx, dryRun: false, log: (l) => say(err().dim(l)), batchSize: 500, ...over });

/** Read at most `limit` rows (all when null) of a PDF, with the columns they have. */
async function peek(ctx: Context, config: PdfSourceConfig, limit: number | null): Promise<{ columns: string[]; rows: Row[] }> {
  const source = await pdfAdapter.source!(config, ioFor(ctx, { log: () => undefined }));
  const rows: Row[] = [];
  try {
    outer: for await (const batch of source.batches()) {
      for (const row of batch) {
        if (limit !== null && rows.length >= limit) break outer;
        rows.push(row);
      }
    }
  } finally {
    await source.close();
  }
  return { columns: columnsOf(rows), rows };
}

/** `k=v`: the value is JSON when it parses as a list, object, number or boolean, else text. */
export function parseOptionArg(arg: string): [string, unknown] {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new PdfError(`"${arg}" is not an option: write it as name=value`);
  const key = arg.slice(0, eq);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) throw new PdfError(`"${key}" is not a valid option name`);
  const raw = arg.slice(eq + 1);
  if (/^(\[|\{|"|true$|false$|null$|-?\d)/.test(raw)) {
    try {
      return [key, JSON.parse(raw) as unknown];
    } catch {
      // not JSON after all: it is text
    }
  }
  return [key, raw];
}

const FORMATS = ['csv', 'json', 'ndjson'] as const;
type Format = (typeof FORMATS)[number];

/** Rows from the text of a CSV (first record is the header), JSON (a list of objects) or NDJSON file. */
export function parseRows(text: string, format: Format, what: string): Row[] {
  if (format === 'csv') {
    const recs = parseCsv(text);
    const head = recs.shift();
    if (!head) return [];
    if (new Set(head).size !== head.length || head.some((h) => h === '')) throw new PdfError(`${what}: the header needs a distinct name for every column`);
    return recs.filter((r) => !(r.length === 1 && r[0] === '')).map((r, i) => {
      if (r.length !== head.length) throw new PdfError(`${what}: record ${i + 2} has ${r.length} values, expected ${head.length}`);
      return Object.fromEntries(head.map((h, k) => [h, r[k]!]));
    });
  }
  const asRow = (v: unknown, where: string): Row => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PdfError(`${what}: ${where} is not an object`);
    return v as Row;
  };
  try {
    if (format === 'json') {
      const v: unknown = JSON.parse(text);
      if (!Array.isArray(v)) throw new PdfError(`${what}: JSON input must be a list of objects`);
      return v.map((x, i) => asRow(x, `item ${i + 1}`));
    }
    return text
      .split(/\r?\n/)
      .map((l, i) => [l, i + 1] as const)
      .filter(([l]) => l.trim() !== '')
      .map(([l, n]) => asRow(JSON.parse(l), `line ${n}`));
  } catch (e) {
    if (e instanceof PdfError) throw e;
    throw new PdfError(`${what}: not valid ${format === 'json' ? 'JSON' : 'NDJSON'} (${e instanceof Error ? e.message : String(e)})`);
  }
}

function formatOf(file: string, given: string | undefined): Format | null {
  if (given !== undefined) return (FORMATS as readonly string[]).includes(given) ? (given as Format) : null;
  const ext = path.extname(file).toLowerCase();
  return ext === '.csv' ? 'csv' : ext === '.json' ? 'json' : ext === '.ndjson' || ext === '.jsonl' ? 'ndjson' : null;
}

async function readInput(file: string): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return await fs.promises.readFile(path.resolve(file), 'utf8');
  } catch (e) {
    throw new PdfError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runInfo(rest: string[], json: boolean): Promise<number> {
  const file = rest.shift();
  if (!file) return usageError('info needs a PDF file', USAGE_BY_SUB.info);
  if (rest.length) return usageError(`unexpected ${rest.join(' ')}`, USAGE_BY_SUB.info);
  let pdf;
  try {
    pdf = openPdf(await fs.promises.readFile(path.resolve(file)));
  } catch (e) {
    if (e instanceof PdfError) return fail(new PdfError(`${file}: ${e.message}`, e.hint), 'info');
    return fail(new PdfError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`), 'info');
  }
  const info = pdf.info();
  const sizes = Array.from({ length: pdf.pageCount }, (_, i) => ({ page: i + 1, ...pdf.pageSize(i + 1) }));
  if (json) {
    process.stdout.write(JSON.stringify({ file, version: pdf.version, pages: pdf.pageCount, ...info, pageSizes: sizes }, null, 2) + '\n');
    return 0;
  }
  const c = out();
  const distinct = [...new Set(sizes.map((s) => `${Math.round(s.width)} x ${Math.round(s.height)} pt`))];
  const rows: [string, string][] = [
    ['file', file],
    ['PDF version', pdf.version],
    ['pages', String(pdf.pageCount)],
    ['page size', distinct.length ? distinct.join(', ') : '-'],
    ...Object.entries(info).map(([k, v]) => [k, String(v)] as [string, string]),
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  process.stdout.write(rows.map(([k, v]) => `${c.dim(k.padEnd(w))}  ${v}`).join('\n') + '\n');
  return 0;
}

async function runWrite(ctx: Context, rest: string[], flags: { dryRun: boolean; yes: boolean; overwrite: boolean }): Promise<number> {
  const usage = USAGE_BY_SUB.write!;
  const from = takeOption(rest, '--from');
  const template = takeOption(rest, '--template');
  const formatArg = takeOption(rest, '--format');
  const title = takeOption(rest, '--title');
  const author = takeOption(rest, '--author');
  const size = takeOption(rest, '--size');
  const orientation = takeOption(rest, '--orientation');
  const margin = takeOption(rest, '--margin');
  const options: Record<string, unknown> = {};
  try {
    for (let a = takeOption(rest, '--option'); a !== undefined; a = takeOption(rest, '--option')) {
      const [k, v] = parseOptionArg(a);
      options[k] = v;
    }
  } catch (e) {
    return usageError(e instanceof Error ? e.message : String(e), usage);
  }
  const target = rest.shift();
  if (!target) return usageError('write needs the PDF file to write (or - for standard output)', usage);
  if (rest.length) return usageError(`unexpected ${rest.join(' ')}`, usage);
  if (!from) return usageError('write needs --from <rows.csv|rows.json|rows.ndjson|->', usage);
  const format = formatOf(from, formatArg);
  if (!format) return usageError(formatArg ? `--format must be one of ${FORMATS.join(', ')}` : `cannot tell the format of ${from}: give --format csv|json|ndjson`, usage);
  if (size !== undefined && !(size in PAGE_SIZES)) return usageError(`--size must be one of ${Object.keys(PAGE_SIZES).join(', ')}`, usage);
  if (orientation !== undefined && orientation !== 'portrait' && orientation !== 'landscape') return usageError('--orientation must be portrait or landscape', usage);
  const marginN = margin === undefined ? undefined : Number(margin);
  if (marginN !== undefined && !(marginN >= 0 && marginN < 400)) return usageError('--margin must be a number of points', usage);
  const page: PageSetup = {
    ...(size ? { size: size as keyof typeof PAGE_SIZES } : {}),
    ...(orientation ? { orientation: orientation as 'portrait' | 'landscape' } : {}),
    ...(marginN !== undefined ? { margin: marginN } : {}),
  };
  const config: PdfSinkConfig = {
    path: target,
    template: template ?? 'table',
    options,
    ...(Object.keys(page).length ? { page } : {}),
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    mode: flags.overwrite ? 'overwrite' : 'create',
  };

  try {
    const rows = parseRows(await readInput(from), format, from === '-' ? 'standard input' : from);
    const io = ioFor(ctx, { dryRun: flags.dryRun });
    const sink = await pdfAdapter.sink!(config, io); // checks the target and the template before asking anything
    let ok = false;
    try {
      if (flags.overwrite && !flags.dryRun && target !== '-' && fs.existsSync(path.resolve(target)) && !flags.yes) {
        if (!(await confirm(`Replace ${target}?`, false, { flag: '--yes' }))) {
          say(err().dim('not replaced'));
          return 1;
        }
      }
      for (let i = 0; i < rows.length; i += io.batchSize) await sink.write(rows.slice(i, i + io.batchSize));
      ok = true;
    } finally {
      await sink.close(ok);
    }
    if (!flags.dryRun && target !== '-') {
      const pages = openPdf(fs.readFileSync(path.resolve(target))).pageCount;
      say(badge.success(`wrote ${target} (${rows.length} row${rows.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'})`, err()));
    }
    return 0;
  } catch (e) {
    return fail(e, 'write');
  }
}

async function runTemplates(rest: string[], json: boolean, dryRun: boolean): Promise<number> {
  const usage = USAGE_BY_SUB.templates!;
  const sub = rest.shift();
  if (sub === 'new') {
    const dir = takeOption(rest, '--dir');
    const name = rest.shift();
    if (!name) return usageError('templates new needs a name for the layout', USAGE[5]);
    if (rest.length) return usageError(`unexpected ${rest.join(' ')}`, USAGE[5]);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || BUILTIN_TEMPLATES.some((t) => t.id === name)) {
      return usageError(`"${name}" cannot name a layout (letters, digits, dots and dashes; not a built-in id)`, USAGE[5]);
    }
    const folder = path.resolve(dir ?? userTemplateDir());
    const file = path.join(folder, `${name}.json`);
    if (fs.existsSync(file)) return fail(new PdfError(`${file} already exists`, 'pick another name or edit that file'), 'templates');
    if (dryRun) {
      say(err().dim(`would write ${file}`));
      return 0;
    }
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(starterLayout(name), null, 2) + '\n', { flag: 'wx' });
    } catch (e) {
      return fail(new PdfError(`cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`), 'templates');
    }
    say(badge.success(`wrote ${file}`, err()));
    say(err().dim(`  use it: pf pdf write out.pdf --from rows.csv --template ${dir ? file : name} --option title="My report" --option company=Acme`));
    return 0;
  }
  if (sub !== undefined && sub !== 'list') return usageError(`unknown templates subcommand "${sub}"`, usage);
  if (rest.length) return usageError(`unexpected ${rest.join(' ')}`, usage);

  const saved = listUserTemplates().map((t) => {
    try {
      const layout = parseLayoutText(fs.readFileSync(t.file, 'utf8'), t.file);
      return { name: t.name, file: t.file, summary: layout.summary ?? '', error: null as string | null };
    } catch (e) {
      return { name: t.name, file: t.file, summary: '', error: e instanceof Error ? e.message : String(e) };
    }
  });
  if (json) {
    process.stdout.write(
      JSON.stringify({ builtin: BUILTIN_TEMPLATES.map((t) => ({ id: t.id, summary: t.summary ?? '', options: t.options ?? {} })), saved, layoutSchema: LAYOUT_SCHEMA }, null, 2) + '\n',
    );
    return 0;
  }
  const c = out();
  const rows = [
    ...BUILTIN_TEMPLATES.map((t) => [t.id, 'built in', t.summary ?? ''] as string[]),
    ...saved.map((t) => [t.name, 'saved', t.error ? c.red(`invalid: ${t.error}`) : t.summary || t.file]),
  ];
  process.stdout.write(table(['template', 'from', 'what'], rows, c) + '\n');
  say(err().dim(`saved layouts live in ${userTemplateDir()}; pf pdf templates new <name> makes one`));
  return 0;
}

export const pdfCommand: Command = {
  name: 'pdf',
  summary: 'Work with PDF files: info, text, show, write from a layout template (the pdf adapter is what pipes read and write)',
  group: 'Tools',
  usage: USAGE.join('\n'),
  async run(ctx, args) {
    const rest = [...args];
    const sub = rest.shift();
    if (!sub || sub === 'help') {
      process.stdout.write(USAGE.map((u) => termLine(u, out())).join('\n') + '\n');
      return 0;
    }
    if (!['info', 'text', 'show', 'write', 'templates'].includes(sub)) return usageError(`unknown subcommand "${sub}"`, USAGE.join('  |  '));
    const json = takeFlag(rest, '--json');
    const dryRun = takeFlag(rest, '--dry-run');
    const yes = takeFlag(rest, '--yes', '-y');
    const overwrite = takeFlag(rest, '--overwrite');
    const usage = USAGE_BY_SUB[sub]!;

    if (sub === 'info') return runInfo(rest, json);
    if (sub === 'write') return runWrite(ctx, rest, { dryRun, yes, overwrite });
    if (sub === 'templates') return runTemplates(rest, json, dryRun);

    const pages = takeOption(rest, '--pages');
    const extractRaw = takeOption(rest, '--extract');
    const limitRaw = takeOption(rest, '--limit');
    const file = rest.shift();
    if (!file) return usageError(`${sub} needs a PDF file`, usage);
    if (rest.length) return usageError(`unexpected ${rest.join(' ')}`, usage);
    const extract = (extractRaw ?? 'lines') as ExtractMode;
    if (!EXTRACT_MODES.includes(extract)) return usageError(`--extract must be one of ${EXTRACT_MODES.join(', ')}`, usage);
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) return usageError(`--limit must be a whole number of at least 1 (got "${String(limitRaw)}")`, usage);
    const config: PdfSourceConfig = { path: file, extract: sub === 'text' ? 'text' : extract, ...(pages ? { pages } : {}) };

    try {
      if (sub === 'text') {
        const { rows } = await peek(ctx, config, null);
        process.stdout.write(String(rows[0]?.text ?? '') + '\n');
        return 0;
      }
      const { columns, rows } = await peek(ctx, config, limit + 1);
      const shown = rows.slice(0, limit);
      if (json) process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
      else if (shown.length === 0) process.stdout.write(`${out().dim('(no rows)')}\n`);
      else process.stdout.write(table(columns, shown.map((r) => columns.map((k) => cellText(r[k]))), out()) + '\n');
      if (rows.length > limit) say(err().dim(`first ${limit} rows (--limit <n> shows more)`));
      return 0;
    } catch (e) {
      return fail(e, sub);
    }
  },
};
