import { cellText, columnsOf } from '@pulpfixer/kit/csv';
import type { Context } from '@pulpfixer/kit/context';
import type { IoContext, Row } from '@pulpfixer/kit/io';
import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { badge, table, termLine } from '@pulpfixer/kit/ui/text';
import { takeFlag, takeOption } from '@pulpfixer/kit/util';
import { CsvError, csvAdapter, type CsvSourceConfig } from '../adapter.js';

const say = (s: string): void => void process.stderr.write(s + '\n');

const USAGE = ['pf csv show <file> [--limit <n>] [--delimiter <c>] [--no-header] [--json]', 'pf csv columns <file> [--delimiter <c>] [--json]'];

const usageError = (msg: string, usage = USAGE[0]!): number => {
  const c = err();
  say(`${badge.error(msg, c)}\n  ${c.dim('usage')} ${termLine(usage, c)}`);
  return 2;
};

const delimiterOf = (v: string | undefined): string | undefined => (v === 'tab' || v === '\\t' ? '\t' : v);

/** Read at most `limit` rows (all when null) of a CSV file, with the columns it has. */
async function peek(ctx: Context, config: CsvSourceConfig, limit: number | null): Promise<{ columns: string[]; rows: Row[] }> {
  const io: IoContext = { ctx, dryRun: false, log: () => undefined, batchSize: 500 };
  const source = await csvAdapter.source!(config, io);
  const rows: Row[] = [];
  let columns: string[] = [];
  try {
    outer: for await (const batch of source.batches()) {
      for (const row of batch) {
        if (limit !== null && rows.length >= limit) break outer;
        if (columns.length === 0) columns = Object.keys(row);
        rows.push(row);
      }
    }
  } finally {
    await source.close();
  }
  return { columns: columns.length ? columns : columnsOf(rows), rows };
}

async function columnsOnly(ctx: Context, config: CsvSourceConfig): Promise<string[]> {
  return (await peek(ctx, config, 1)).columns;
}

export const csvCommand: Command = {
  name: 'csv',
  summary: 'Look at CSV files (the csv adapter is what pipes read and write)',
  group: 'Tools',
  usage: USAGE.join('\n'),
  async run(ctx, args) {
    const rest = [...args];
    const sub = rest.shift();
    if (!sub || sub === 'help') {
      process.stdout.write(USAGE.map((u) => termLine(u, out())).join('\n') + '\n');
      return 0;
    }
    if (sub !== 'show' && sub !== 'columns') return usageError(`unknown subcommand "${sub}"`, USAGE.join('  |  '));

    const json = takeFlag(rest, '--json');
    const noHeader = takeFlag(rest, '--no-header');
    const limitRaw = takeOption(rest, '--limit');
    const delimiter = delimiterOf(takeOption(rest, '--delimiter'));
    const usage = sub === 'show' ? USAGE[0]! : USAGE[1]!;
    const file = rest.shift();
    if (!file) return usageError(`${sub} needs a CSV file`, usage);
    if (rest.length) return usageError(`unexpected ${rest.join(' ')}`, usage);
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) return usageError(`--limit must be a whole number of at least 1 (got "${String(limitRaw)}")`, usage);
    const config: CsvSourceConfig = { path: file, ...(delimiter ? { delimiter } : {}), ...(noHeader ? { header: false } : {}) };

    try {
      if (sub === 'columns') {
        const columns = await columnsOnly(ctx, config);
        process.stdout.write((json ? JSON.stringify(columns) : columns.join('\n')) + '\n');
        return 0;
      }
      // One more row than shown tells whether there are more.
      const { columns, rows } = await peek(ctx, config, limit + 1);
      const shown = rows.slice(0, limit);
      if (json) {
        process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
      } else if (shown.length === 0) {
        process.stdout.write(`${out().dim('(no rows)')}\n`);
      } else {
        process.stdout.write(table(columns, shown.map((r) => columns.map((k) => cellText(r[k]))), out()) + '\n');
      }
      if (rows.length > limit) say(err().dim(`first ${limit} rows (--limit <n> shows more)`));
      return 0;
    } catch (e) {
      if (e instanceof CsvError) {
        say(badge.error(e.message, err()));
        return 1;
      }
      say(badge.error(`csv ${sub} failed: ${e instanceof Error ? e.message : String(e)}`, err()));
      return 1;
    }
  },
};
