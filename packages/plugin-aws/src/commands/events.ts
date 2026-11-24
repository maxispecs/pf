import fs from 'node:fs';
import type { Command } from '@pulpfixer/kit/types';
import { err } from '@pulpfixer/kit/ui/palette';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { buildEntry, checkTarget, describeFailure, EventsError, sendEntries } from '../events.js';
import { needAws } from './shared.js';

const USAGE =
  'pf events put --source <s> --type <detail-type> [--detail <json> | --detail-file <path|->] [--bus <name|arn>] [--resource <arn>]... [--time <iso>] [--profile p] [--region r] [--dry-run] [--yes]';

/** Every `--name value`, removed from args. */
function takeAll(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let v = takeOption(args, name); v !== undefined; v = takeOption(args, name)) values.push(v);
  return values;
}

const usageError = (message: string): number => {
  process.stderr.write(`${badgeLabel('error', err())} ${message}\n`);
  return 2;
};

function readDetail(inline: string | undefined, file: string | undefined): Record<string, unknown> {
  if (inline !== undefined && file !== undefined) throw new EventsError('give the detail once: --detail or --detail-file, not both');
  if (inline === undefined && file === undefined) return {};
  let text: string;
  if (inline !== undefined) text = inline;
  else if (file === '-') {
    if (process.stdin.isTTY) throw new EventsError('--detail-file - reads standard input, but it is a terminal: pipe the JSON in');
    text = fs.readFileSync(0, 'utf8');
  } else {
    try {
      text = fs.readFileSync(file!, 'utf8');
    } catch (e) {
      throw new EventsError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new EventsError(`the detail is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new EventsError('the detail must be a JSON object');
  return parsed as Record<string, unknown>;
}

async function put(args: string[]): Promise<number> {
  const c = err();
  const dryRun = takeFlag(args, '--dry-run', '-n');
  const yes = takeFlag(args, '--yes', '-y');
  const source = takeOption(args, '--source');
  const type = takeOption(args, '--type');
  const bus = takeOption(args, '--bus');
  const time = takeOption(args, '--time');
  const profile = takeOption(args, '--profile');
  const region = takeOption(args, '--region');
  const detailText = takeOption(args, '--detail');
  const detailFile = takeOption(args, '--detail-file');
  const resources = takeAll(args, '--resource');
  if (args.length) return usageError(`unexpected argument "${args[0]}". ${termLine(USAGE, c)}`);
  if (source === undefined || type === undefined) return usageError(`--source and --type are required: ${termLine(USAGE, c)}`);

  let entry;
  let target;
  try {
    const detail = readDetail(detailText, detailFile);
    entry = buildEntry({ source, detailType: type, detail, ...(bus !== undefined ? { bus } : {}), resources, ...(time !== undefined ? { time } : {}) });
    target = checkTarget({ ...(profile !== undefined ? { profile } : {}), ...(region !== undefined ? { region } : {}) });
  } catch (e) {
    return usageError(e instanceof Error ? e.message : String(e));
  }

  const detailShown = entry.Detail.length > 400 ? `${entry.Detail.slice(0, 397)}...` : entry.Detail;
  const rows: [string, string][] = [
    ['bus', entry.EventBusName ?? c.dim('(default bus)')],
    ['source', entry.Source],
    ['type', entry.DetailType],
    ['detail', detailShown],
    ...(entry.Resources ? ([['resources', entry.Resources.join(', ')]] as [string, string][]) : []),
    ...(entry.Time ? ([['time', entry.Time]] as [string, string][]) : []),
    ['account', `${target.profile ? `profile ${target.profile}` : c.dim('(aws default profile)')}${target.region ? `, ${target.region}` : ''}`],
  ];
  for (const [k, v] of rows) process.stderr.write(`  ${c.dim(k.padEnd(9))} ${v}\n`);

  if (dryRun) {
    process.stderr.write(`${c.dim('would send 1 event with aws events put-events')}\n`);
    return 0;
  }
  if (!yes) {
    if (!interactive()) return usageError(`sending an event needs a terminal to confirm, or ${termLine('--yes', c)}`);
    if (!(await confirm('Send this event?', false))) {
      process.stderr.write(c.dim('cancelled, nothing sent\n'));
      return 1;
    }
  }
  if (!needAws()) return 127;

  const report = await sendEntries([entry], target);
  if (report.error || report.failures.length || report.sent !== 1) {
    process.stderr.write(`${badgeLabel('error', c)} the event was not sent\n${describeFailure(report, 1)}\n`);
    return 1;
  }
  process.stdout.write(`${report.ids[0]}\n`);
  process.stderr.write(`${c.green('✓')} sent event ${report.ids[0]}\n`);
  return 0;
}

export const eventsCommand: Command = {
  name: 'events',
  summary: 'Send an event to Amazon EventBridge',
  group: 'AWS',
  usage: USAGE,
  async run(_ctx, args) {
    const rest = [...args];
    const sub = rest.shift();
    if (sub === undefined || sub === 'help' || sub === '--help') {
      process.stderr.write(`${termLine(USAGE, err())}\n${err().dim('Needs the aws CLI and events:PutEvents. The detail is a JSON object (--detail \'{"id":1}\', or a file, or - for standard input).')}\n`);
      return 0;
    }
    if (sub === 'put') return await put(rest);
    return usageError(`unknown subcommand "${sub}". ${termLine(USAGE, err())}`);
  },
};
