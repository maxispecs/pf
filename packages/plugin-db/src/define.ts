import type { Context } from '@pulpfixer/kit/context';
import type { Plugin } from '@pulpfixer/kit/plugin';
import type { Command, Group } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { badge, termLine, usageTable } from '@pulpfixer/kit/ui/text';
import { takeFlag, takeOption } from '@pulpfixer/kit/util';
import { flagName, parseParams, type ParamDef, type Params } from '@pulpfixer/kit/params';
import { withDb, type Db } from './client.js';
import { DbError } from './errors.js';
import { render, type Format } from './output.js';
import type { CompiledQuery } from '@pulpfixer/kit/db';

export { parseParams, type ParamDef, type Params, type ParsedParams } from '@pulpfixer/kit/params';

export interface QueryContext {
  ctx: Context;
  /** True under `--dry-run`: writes are shown, not run. */
  dryRun: boolean;
}

export interface QueryDef {
  summary: string;
  params?: Record<string, ParamDef>;
  /** The query changes data: it confirms first (`--yes` skips it) and honors `--dry-run`. Without this, writes are refused. */
  writes?: boolean;
  /** Return rows (an array of objects, or what `db.query` gives), or nothing. */
  run(db: Db, params: Params, q: QueryContext): unknown;
}

export interface QueryPackage {
  /** The command: `pf <name> <query>`. */
  name: string;
  summary: string;
  /** The connection to use unless `--db <name>` says otherwise (see `pf db add`). */
  connection: string;
  /** The driver `pf db add` suggests when the connection is missing. */
  driver?: string;
  group?: Group;
  queries: Record<string, QueryDef>;
}

/** `pf revrec monthly --month <month> [--product <product>]`. */
export function queryUsage(pkg: string, name: string, def: QueryDef): string {
  const parts = Object.entries(def.params ?? {}).map(([k, p]) => {
    const arg = p.type === 'boolean' ? flagName(k) : `${flagName(k)} <${k}>`;
    return p.required ? arg : `[${arg}]`;
  });
  return ['pf', pkg, name, ...parts].join(' ');
}

const fail = (msg: string, hint?: string): number => {
  const c = err();
  process.stderr.write(`${badge.error(msg, c)}${hint ? `\n  ${c.dim('try')} ${termLine(hint, c)}` : ''}\n`);
  return 1;
};

function listQueries(pkg: QueryPackage, connection: string): number {
  const c = out();
  const rows = Object.entries(pkg.queries).map(([name, def]) => ({
    usage: queryUsage(pkg.name, name, def),
    summary: def.summary + (def.writes ? ' (changes data)' : ''),
  }));
  process.stdout.write(`${c.bold(pkg.summary)}\n${usageTable(rows, c)}\n`);
  process.stderr.write(
    `${err().dim(`Uses the "${connection}" connection (--db <name> for another). Output: --json, --csv. Changes data only after a confirmation (--yes skips it, --dry-run shows).`)}\n`,
  );
  return 0;
}

function formatOf(args: string[]): Format | string {
  const json = takeFlag(args, '--json');
  const csv = takeFlag(args, '--csv');
  const tbl = takeFlag(args, '--table');
  if ([json, csv, tbl].filter(Boolean).length > 1) return 'use one of --json, --csv, --table';
  return json ? 'json' : csv ? 'csv' : 'table';
}

/**
 * A plugin for a set of named queries on one connection. This is what a query package default-exports:
 *
 *   export default defineQueries({
 *     name: 'revrec',
 *     summary: 'Revenue recognition',
 *     connection: 'billing',
 *     queries: {
 *       monthly: {
 *         summary: 'Recognized revenue for a month',
 *         params: { month: { required: true, help: 'YYYY-MM' } },
 *         run: (db, { month }) => db.all(sql`SELECT ... WHERE period = ${month}`),
 *       },
 *     },
 *   });
 *
 * `pf revrec` lists the queries; `pf revrec monthly --month 2026-10 [--csv|--json] [--db other]` runs one.
 */
export function defineQueries(pkg: QueryPackage): Plugin {
  const command: Command = {
    name: pkg.name,
    summary: pkg.summary,
    group: pkg.group ?? 'Tools',
    usage: `pf ${pkg.name} [query] [--param value ...] [--json|--csv] [--db <connection>]`,
    async run(ctx, args) {
      const rest = [...args];
      const dbOpt = takeOption(rest, '--db');
      const connection = dbOpt ?? pkg.connection;
      const name = rest[0];
      if (!name || name === 'list' || name === 'help') return listQueries(pkg, connection);
      const def = Object.hasOwn(pkg.queries, name) ? pkg.queries[name] : undefined;
      if (!def) {
        process.stderr.write(`${badge.error(`no query "${name}" in ${pkg.name}. Have: ${Object.keys(pkg.queries).join(', ')}`, err())}\n`);
        return 2;
      }
      rest.shift();

      const format = formatOf(rest);
      if (format !== 'table' && format !== 'json' && format !== 'csv') return (process.stderr.write(`${badge.error(format, err())}\n`), 2);
      const yes = takeFlag(rest, '--yes', '-y');
      const dryRun = takeFlag(rest, '--dry-run', '-n');
      const parsed = parseParams(def.params, rest);
      if ('error' in parsed) return (process.stderr.write(`${badge.error(parsed.error, err())}\n  ${err().dim('usage')} ${termLine(queryUsage(pkg.name, name, def), err())}\n`), 2);
      if (rest.length) return (process.stderr.write(`${badge.error(`unexpected ${rest.join(' ')}`, err())}\n  ${err().dim('usage')} ${termLine(queryUsage(pkg.name, name, def), err())}\n`), 2);

      if (def.writes && !dryRun && !yes) {
        if (!(await confirm(`"${pkg.name} ${name}" changes data in the "${connection}" connection. Run it?`, false, { flag: '--yes' }))) {
          process.stderr.write(`${err().dim('nothing was run')}\n`);
          return 1;
        }
      }

      const onDryWrite = (q: CompiledQuery) => {
        const c = err();
        process.stderr.write(`${c.dim('would run')} ${q.text}${q.values.length ? c.dim(`   ${JSON.stringify(q.values, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`) : ''}\n`);
      };
      try {
        const result = await withDb(
          connection,
          async (db) => def.run(db, parsed.values, { ctx, dryRun }),
          { writes: def.writes ? (dryRun ? 'dry' : 'allow') : 'deny', onDryWrite, ...(pkg.driver ? { driver: pkg.driver } : {}) },
        );
        const text = render(result, format, out());
        if (text) process.stdout.write(text + '\n');
        return 0;
      } catch (e) {
        if (e instanceof DbError) return fail(e.message, e.hint);
        return fail(`${pkg.name} ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
  return {
    name: pkg.name,
    summary: pkg.summary,
    commands: [command],
    entries: (ctx) => [{ name: pkg.name, summary: pkg.summary, group: command.group, run: () => command.run(ctx, []) }],
  };
}
