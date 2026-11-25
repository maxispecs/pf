import fs from 'node:fs';
import type { Context } from '@pulpfixer/kit/context';
import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { ask, confirm } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, table, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import {
  loadPublishers,
  publisherName,
  publishersPath,
  putPublisher,
  readIdentity,
  removePublisher,
  repoRootOf,
  validatePublisher,
  writeIdentity,
  type PartialIdentity,
  type Publisher,
} from '../config.js';
import { prepareDispatch, sendPrepared } from '../dispatch.js';
import { CriError } from '../errors.js';
import { selectPublisher, checkRoute } from '../select.js';

const USAGE_LIST = 'pf cri [list] [--json]';
const USAGE_ADD = 'pf cri publisher add [<prefix>] --bus <name|arn> [--region r] [--profile p] [--source s] [--default] [--dry-run]';
const USAGE_REMOVE = 'pf cri publisher remove <prefix|default>';
const USAGE_TEST = 'pf cri publisher test <route>';
const USAGE_IDENTITY = 'pf cri identity [--domain d] [--stack s] [--dry-run]';
const USAGE_SEND =
  'pf cri send <route> [--args <json> | --args-file <path|->] [--correlation-id id] [--causation-id id] [--topic-id id] [--hash h] [--json] [--dry-run] [--yes]';
const USAGE = [USAGE_LIST, USAGE_ADD, USAGE_REMOVE, USAGE_TEST, USAGE_IDENTITY, USAGE_SEND].join('\n');

const usageError = (message: string): number => {
  process.stderr.write(`${badgeLabel('error', err())} ${message}\n`);
  return 2;
};

function failure(e: unknown): number {
  const c = err();
  if (e instanceof CriError) {
    process.stderr.write(`${badgeLabel('error', c)} ${e.message}\n${e.hint ? `${c.dim('try:')} ${termLine(e.hint, c)}\n` : ''}`);
    return 1;
  }
  throw e;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function describePublisher(p: Publisher): string {
  const parts = [`bus ${p.bus}`, ...(p.region ? [`region ${p.region}`] : []), ...(p.profile ? [`profile ${p.profile}`] : []), ...(p.source ? [`source ${p.source}`] : [])];
  return parts.join(', ');
}

// ---- list ----

function list(ctx: Context, args: string[]): number {
  const json = takeFlag(args, '--json');
  if (args.length) return usageError(`unexpected argument "${args[0]}". ${termLine(USAGE_LIST, err())}`);
  let publishers: Publisher[];
  try {
    publishers = loadPublishers();
  } catch (e) {
    return failure(e);
  }
  const identity = readIdentity(ctx.repo?.root ?? repoRootOf(ctx.cwd));
  if (json) {
    process.stdout.write(`${JSON.stringify({ identity, publishers }, null, 2)}\n`);
    return 0;
  }
  const c = err();
  process.stderr.write(`${c.dim('stack')}  ${identity.stack ?? c.dim('(not set)')}  ${c.dim('domain')}  ${identity.domain ?? c.dim('(not set)')}\n`);
  if (!identity.domain || !identity.stack) process.stderr.write(`${c.dim('set it with')} ${termLine('pf cri identity --domain <d> --stack <s>', c)}\n`);
  if (!publishers.length) {
    process.stderr.write(`${c.dim('no publishers yet:')} ${termLine('pf cri publisher add --bus <bus>', c)}\n`);
    return 0;
  }
  const rows = [...publishers]
    .sort((a, b) => (a.prefix ? 0 : 1) - (b.prefix ? 0 : 1) || publisherName(a).localeCompare(publisherName(b)))
    .map((p) => [p.prefix ?? c.dim('(default)'), p.type, p.bus, p.region ?? c.dim('-'), p.profile ?? c.dim('-'), p.source ?? c.dim('(stack)')]);
  process.stdout.write(`${table(['Prefix', 'Type', 'Bus', 'Region', 'Profile', 'Source'], rows, out())}\n`);
  process.stderr.write(`${c.dim(publishersPath())}\n`);
  return 0;
}

// ---- publisher ----

async function publisherAdd(args: string[]): Promise<number> {
  const c = err();
  const dryRun = takeFlag(args, '--dry-run', '-n');
  const asDefault = takeFlag(args, '--default');
  let bus = takeOption(args, '--bus');
  let region = takeOption(args, '--region');
  let profile = takeOption(args, '--profile');
  const source = takeOption(args, '--source');
  const given = args.shift();
  if (args.length) return usageError(`unexpected argument "${args[0]}". ${termLine(USAGE_ADD, c)}`);
  if (asDefault && given !== undefined) return usageError('--default and a prefix do not go together: the default publisher has no prefix');
  let prefix = given;

  if (interactive()) {
    if (!asDefault && prefix === undefined) {
      const v = await ask('Route prefix (empty = the default publisher)', { placeholder: '@payments/ or audit/', validate: (s) => (s === '' || /^@?[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(s) ? null : 'end the prefix with "/"') });
      if (v === null) return 1;
      prefix = v || undefined;
    }
    if (bus === undefined) {
      const v = await ask('EventBridge bus (name or ARN)', { validate: (s) => (s ? null : 'a bus is required') });
      if (v === null) return 1;
      bus = v;
    }
    if (region === undefined && profile === undefined) {
      const r = await ask('AWS region (empty = the aws CLI default)');
      if (r === null) return 1;
      region = r || undefined;
      const p = await ask('AWS profile (empty = the aws CLI default or AWS_* variables)');
      if (p === null) return 1;
      profile = p || undefined;
    }
  }
  if (bus === undefined) return usageError(`--bus is required: ${termLine(USAGE_ADD, c)}`);

  let publisher: Publisher;
  try {
    publisher = validatePublisher({ type: 'eventbridge', ...(prefix ? { prefix } : {}), bus, ...(region ? { region } : {}), ...(profile ? { profile } : {}), ...(source ? { source } : {}) });
  } catch (e) {
    return usageError(msg(e));
  }
  if (dryRun) {
    process.stderr.write(`${c.dim('would save')} ${publisherName(publisher)}: ${describePublisher(publisher)}\n`);
    return 0;
  }
  try {
    const { replaced } = putPublisher(publisher);
    process.stderr.write(`${c.green('✓')} ${replaced ? 'updated' : 'added'} the ${publisherName(publisher)} publisher: ${describePublisher(publisher)}\n`);
    return 0;
  } catch (e) {
    return failure(e);
  }
}

function publisherRemove(args: string[]): number {
  const name = args.shift();
  if (name === undefined || args.length) return usageError(`usage: ${termLine(USAGE_REMOVE, err())}`);
  try {
    const gone = removePublisher(name);
    if (!gone) {
      process.stderr.write(`${badgeLabel('error', err())} no publisher "${name}" (see pf cri list)\n`);
      return 1;
    }
    process.stderr.write(`${err().green('✓')} removed the ${name} publisher\n`);
    return 0;
  } catch (e) {
    return failure(e);
  }
}

function publisherTest(args: string[]): number {
  const route = args.shift();
  if (route === undefined || args.length) return usageError(`usage: ${termLine(USAGE_TEST, err())}`);
  try {
    checkRoute(route);
    const p = selectPublisher(loadPublishers(), route);
    process.stderr.write(`${err().green('✓')} "${route}" goes through the ${publisherName(p)} publisher: ${describePublisher(p)}\n`);
    return 0;
  } catch (e) {
    return failure(e);
  }
}

async function publisher(args: string[]): Promise<number> {
  const sub = args.shift();
  if (sub === 'add') return publisherAdd(args);
  if (sub === 'remove' || sub === 'rm') return publisherRemove(args);
  if (sub === 'test') return publisherTest(args);
  return usageError(`${sub === undefined ? 'a subcommand is required' : `unknown subcommand "${sub}"`}: ${termLine(`${USAGE_ADD}\n${USAGE_REMOVE}\n${USAGE_TEST}`, err())}`);
}

// ---- identity ----

function identity(ctx: Context, args: string[]): number {
  const c = err();
  const dryRun = takeFlag(args, '--dry-run', '-n');
  const domain = takeOption(args, '--domain');
  const stack = takeOption(args, '--stack');
  if (args.length) return usageError(`unexpected argument "${args[0]}". ${termLine(USAGE_IDENTITY, c)}`);
  const root = ctx.repo?.root ?? repoRootOf(ctx.cwd);
  if (domain === undefined && stack === undefined) {
    const id = readIdentity(root);
    process.stdout.write(`${JSON.stringify(id)}\n`);
    if (!id.domain || !id.stack) process.stderr.write(`${c.dim('not complete: set it with')} ${termLine(USAGE_IDENTITY, c)}\n`);
    return 0;
  }
  if (!root) return usageError('not in a repo: the identity is saved in the repo\'s pulpfixer.json');
  const values: PartialIdentity = { ...(domain !== undefined ? { domain } : {}), ...(stack !== undefined ? { stack } : {}) };
  const r = writeIdentity(root, values, { dryRun });
  if (!r.ok) return usageError(r.error);
  process.stderr.write(`${c.green('✓')} ${dryRun ? 'would save' : r.changed ? 'saved' : 'already set'}: ${Object.entries(values).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
  return 0;
}

// ---- send ----

function readPayload(inline: string | undefined, file: string | undefined): unknown {
  if (inline !== undefined && file !== undefined) throw new CriError('give the payload once: --args or --args-file, not both');
  if (inline === undefined && file === undefined) return {};
  let text: string;
  if (inline !== undefined) text = inline;
  else if (file === '-') {
    if (process.stdin.isTTY) throw new CriError('--args-file - reads standard input, but it is a terminal: pipe the JSON in');
    text = fs.readFileSync(0, 'utf8');
  } else {
    try {
      text = fs.readFileSync(file!, 'utf8');
    } catch (e) {
      throw new CriError(`cannot read ${file}: ${msg(e)}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CriError(`the payload is not valid JSON: ${msg(e)}`);
  }
}

async function send(ctx: Context, args: string[]): Promise<number> {
  const c = err();
  const dryRun = takeFlag(args, '--dry-run', '-n');
  const yes = takeFlag(args, '--yes', '-y');
  const json = takeFlag(args, '--json');
  const inline = takeOption(args, '--args');
  const file = takeOption(args, '--args-file');
  const correlationId = takeOption(args, '--correlation-id');
  const causationId = takeOption(args, '--causation-id');
  const topicId = takeOption(args, '--topic-id');
  const hash = takeOption(args, '--hash');
  const route = args.shift();
  if (route === undefined) return usageError(`a route is required: ${termLine(USAGE_SEND, c)}`);
  if (args.length) return usageError(`unexpected argument "${args[0]}". ${termLine(USAGE_SEND, c)}`);

  let prepared;
  try {
    const payload = readPayload(inline, file);
    prepared = prepareDispatch(route, payload, {
      cwd: ctx.repo?.root ?? ctx.cwd,
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(causationId !== undefined ? { causationId } : {}),
      ...(topicId !== undefined ? { topicId } : {}),
      ...(hash !== undefined ? { hash } : {}),
    });
  } catch (e) {
    return failure(e);
  }

  const detail = prepared.entry.Detail.length > 400 ? `${prepared.entry.Detail.slice(0, 397)}...` : prepared.entry.Detail;
  const rows: [string, string][] = [
    ['route', route],
    ['publisher', prepared.publisher],
    ['bus', prepared.bus],
    ['source', prepared.source],
    ['detail', detail],
    ['account', `${prepared.target.profile ? `profile ${prepared.target.profile}` : c.dim('(aws default profile)')}${prepared.target.region ? `, ${prepared.target.region}` : ''}`],
  ];
  for (const [k, v] of rows) process.stderr.write(`  ${c.dim(k.padEnd(10))} ${v}\n`);

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
  try {
    const result = await sendPrepared(prepared);
    process.stdout.write(json ? `${JSON.stringify({ id: result.id, eventId: result.eventId, route: result.route, publisher: result.publisher, bus: result.bus }, null, 2)}\n` : `${result.eventId}\n`);
    process.stderr.write(`${c.green('✓')} sent event ${result.id} (EventBridge id ${result.eventId})\n`);
    return 0;
  } catch (e) {
    return failure(e);
  }
}

export const criCommand: Command = {
  name: 'cri',
  summary: 'CRI event system: publishers and sending events',
  group: 'AWS',
  usage: USAGE,
  async run(ctx, args) {
    const rest = [...args];
    const sub = rest[0];
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      process.stderr.write(
        `${termLine(USAGE, err())}\n${err().dim('Publishers choose where a route goes (longest prefix wins, else the default one); events carry _meta (id, correlation id, source domain and stack).\nNeeds the aws CLI and events:PutEvents. In code: import { dispatch } from \'@pulpfixer/plugin-cri/api\'.')}\n`,
      );
      return 0;
    }
    if (sub === undefined || sub === 'list' || sub.startsWith('--')) {
      if (sub === 'list') rest.shift();
      return list(ctx, rest);
    }
    rest.shift();
    if (sub === 'publisher' || sub === 'publishers') return await publisher(rest);
    if (sub === 'identity') return identity(ctx, rest);
    if (sub === 'send') return await send(ctx, rest);
    return usageError(`unknown subcommand "${sub}". ${termLine(USAGE, err())}`);
  },
};
