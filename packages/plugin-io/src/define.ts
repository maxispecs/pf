import type { Context } from '@pulpfixer/kit/context';
import type { IoRef, IoSink, IoSource, Row } from '@pulpfixer/kit/io';
import { flagName, parseParams, type ParamDef, type Params } from '@pulpfixer/kit/params';
import type { Plugin } from '@pulpfixer/kit/plugin';
import type { Command, Group } from '@pulpfixer/kit/types';
import { err } from '@pulpfixer/kit/ui/palette';
import { badge, termLine, usageTable } from '@pulpfixer/kit/ui/text';
import { takeFlag, takeOption } from '@pulpfixer/kit/util';
import { IoError } from './errors.js';
import { DEFAULT_BATCH_SIZE, from, type Flow, type FlowSource } from './flow.js';
import { runPipe, type PipeSpec } from './run.js';

export { parseParams, type ParamDef, type Params } from '@pulpfixer/kit/params';

/** What `run` receives. */
export interface PipeRun {
  params: Params;
  /** The opened inputs by name. Start a chain with `from(inputs.name)`. pf closes them. */
  inputs: Record<string, IoSource>;
  /** The opened outputs by name. End a chain with `.to(outputs.name)`. pf closes them and tells each whether the pipe worked. */
  outputs: Record<string, IoSink>;
  /** `from(source)` with this run's batch size. */
  from(source: FlowSource): Flow;
  ctx: Context;
  /** True under `--dry-run`: outputs report what they would do instead of doing it. */
  dryRun: boolean;
  /** One line of progress (stderr). */
  log(line: string): void;
}

/** What `transform` may return: a row, several rows, or nothing to drop the row. */
export type Transformed = Row | Row[] | null | undefined;

export interface PipeDef {
  summary: string;
  params?: Record<string, ParamDef>;
  /** Where rows come from: `{ orders: dbSource({ ... }) }`. The names are how `run` finds them. */
  inputs?: Record<string, IoRef> | ((params: Params) => Record<string, IoRef>);
  /** Where rows go: `{ report: csvSink({ ... }) }`. */
  outputs?: Record<string, IoRef> | ((params: Params) => Record<string, IoRef>);
  /** The coupling, in code. Without it the pipe copies its one input to every output (through `transform` when there is one). */
  run?(p: PipeRun): unknown;
  /** Used when there is no `run`: change each row on its way. Return a row, an array of rows, or null to drop it. */
  transform?(row: Row, params: Params): Transformed | Promise<Transformed>;
}

export interface PipePackage {
  /** The command: `pf <name> <pipe>`. */
  name: string;
  summary: string;
  group?: Group;
  pipes: Record<string, PipeDef>;
}

/** `pf etl copy --from <from> [--dry-run] [--yes]`. */
export function pipeUsage(pkg: string, name: string, def: PipeDef): string {
  const parts = Object.entries(def.params ?? {}).map(([k, p]) => {
    const arg = p.type === 'boolean' ? flagName(k) : `${flagName(k)} <${k}>`;
    return p.required ? arg : `[${arg}]`;
  });
  return ['pf', pkg, name, ...parts, '[--dry-run]', '[--yes]'].join(' ');
}

const say = (s: string): void => void process.stderr.write(s + '\n');
const usageError = (msg: string, usage?: string): number => {
  const c = err();
  say(`${badge.error(msg, c)}${usage ? `\n  ${c.dim('usage')} ${termLine(usage, c)}` : ''}`);
  return 2;
};
const fail = (msg: string, hint?: string): number => {
  const c = err();
  say(`${badge.error(msg, c)}${hint ? `\n  ${c.dim('try')} ${termLine(hint, c)}` : ''}`);
  return 1;
};

function refsOf(def: PipeDef['inputs'], params: Params, role: string): Record<string, IoRef> {
  const refs = typeof def === 'function' ? def(params) : (def ?? {});
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new IoError(`${role} must be an object of IO references`);
  return refs;
}

const rowsOf = (t: Transformed): Row[] => (t === null || t === undefined ? [] : Array.isArray(t) ? t : [t]);

/** The pipe as something `runPipe` can run: declared refs and a body. Exported for tests. */
export function pipeSpec(pkg: string, name: string, def: PipeDef, params: Params, batchSize: number): PipeSpec {
  const label = `${pkg} ${name}`;
  const inputs = refsOf(def.inputs, params, 'inputs');
  const outputs = refsOf(def.outputs, params, 'outputs');
  return {
    label,
    inputs,
    outputs,
    async body({ inputs: ins, outputs: outs }, io) {
      const sinks = Object.values(outs);
      if (def.run) {
        return def.run({ params, inputs: ins, outputs: outs, from: (s) => from(s, batchSize), ctx: io.ctx, dryRun: io.dryRun, log: io.log });
      }
      const names = Object.keys(ins);
      if (names.length !== 1) throw new IoError(`the pipe "${name}" has ${names.length} inputs: without a run() it copies exactly one, so write a run() to say how they combine`);
      if (sinks.length === 0) throw new IoError(`the pipe "${name}" has no outputs`);
      let flow = from(ins[names[0]!]!, batchSize);
      const transform = def.transform;
      if (transform) flow = flow.flatMap(async (row) => rowsOf(await transform(row, params)));
      await flow.to(...sinks);
    },
  };
}

function listPipes(pkg: PipePackage): number {
  const rows = Object.entries(pkg.pipes).map(([name, def]) => ({ usage: pipeUsage(pkg.name, name, def), summary: def.summary }));
  process.stdout.write(`${pkg.summary}\n${usageTable(rows, err())}\n`);
  say(err().dim('Asks before it writes (--yes skips it). --dry-run shows what each output would do. --batch-size <n> sets the rows per batch.'));
  return 0;
}

/**
 * A plugin for a set of named pipes. This is what a pipe package default-exports:
 *
 *   export default definePipes({
 *     name: 'billing-export',
 *     summary: 'Billing data to CSV',
 *     pipes: {
 *       monthly: {
 *         summary: 'Invoices of a month to a CSV file',
 *         params: { month: { required: true, help: 'YYYY-MM' }, out: { default: 'invoices.csv' } },
 *         inputs: ({ month }) => ({ invoices: dbSource({ connection: 'billing', query: sql`SELECT ... WHERE period = ${month}` }) }),
 *         outputs: ({ out }) => ({ file: csvSink({ path: out, mode: 'overwrite' }) }),
 *         transform: (row) => ({ ...row, amount: Number(row.amount) / 100 }),
 *       },
 *     },
 *   });
 *
 * `pf billing-export` lists the pipes; `pf billing-export monthly --month 2026-10 [--dry-run] [--yes]` runs one.
 * A pipe that needs more than copying with a `transform` has a `run` that does the coupling itself.
 */
export function definePipes(pkg: PipePackage): Plugin {
  if (!/^[a-z][a-z0-9-]*$/.test(pkg.name)) throw new Error(`pipe package name "${pkg.name}" must be lowercase letters, digits and dashes`);
  for (const [name, def] of Object.entries(pkg.pipes)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`pipe name "${name}" must be lowercase letters, digits and dashes`);
    if (def.run && def.transform) throw new Error(`pipe "${name}" has both run and transform: use one`);
  }

  const command: Command = {
    name: pkg.name,
    summary: pkg.summary,
    group: pkg.group ?? 'Tools',
    usage: `pf ${pkg.name} [pipe] [--param value ...] [--dry-run] [--yes] [--batch-size <n>]`,
    async run(ctx, args) {
      const rest = [...args];
      const name = rest[0];
      if (!name || name === 'list' || name === 'help') return listPipes(pkg);
      const def = Object.hasOwn(pkg.pipes, name) ? pkg.pipes[name] : undefined;
      if (!def) return usageError(`no pipe "${name}" in ${pkg.name}. Have: ${Object.keys(pkg.pipes).join(', ')}`);
      rest.shift();

      const usage = pipeUsage(pkg.name, name, def);
      const yes = takeFlag(rest, '--yes', '-y');
      const dryRun = takeFlag(rest, '--dry-run', '-n');
      const sizeRaw = takeOption(rest, '--batch-size');
      const batchSize = sizeRaw === undefined ? DEFAULT_BATCH_SIZE : Number(sizeRaw);
      if (!Number.isInteger(batchSize) || batchSize < 1) return usageError(`--batch-size must be a whole number of at least 1 (got "${String(sizeRaw)}")`, usage);
      const parsed = parseParams(def.params, rest);
      if ('error' in parsed) return usageError(parsed.error, usage);
      if (rest.length) return usageError(`unexpected ${rest.join(' ')}`, usage);

      try {
        const report = await runPipe(pipeSpec(pkg.name, name, def, parsed.values, batchSize), { ctx, dryRun, yes, batchSize });
        return report.ran ? 0 : 1;
      } catch (e) {
        // IoError and the errors of adapters (a missing connection says which command adds it) carry a hint.
        const hint = (e as { hint?: unknown } | null)?.hint;
        if (e instanceof IoError || (e instanceof Error && typeof hint === 'string')) return fail(e.message, typeof hint === 'string' ? hint : undefined);
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
