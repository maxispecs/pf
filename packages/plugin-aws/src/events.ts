import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { awsGlobalArgs, awsRun, type AwsTarget } from './aws.js';

/** A problem with an event or with sending it. */
export class EventsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventsError';
  }
}

/** One event, as pf takes it. */
export interface EventInput {
  source: string;
  detailType: string;
  /** A JSON object. */
  detail: Record<string, unknown>;
  /** A bus name or ARN. Without one the account's default bus gets the event. */
  bus?: string;
  resources?: string[];
  /** ISO 8601. Without one EventBridge uses the time it receives the event. */
  time?: string;
}

/** One entry of `aws events put-events --entries`. */
export interface PutEntry {
  Source: string;
  DetailType: string;
  /** The detail, as JSON text. */
  Detail: string;
  EventBusName?: string;
  Resources?: string[];
  Time?: string;
}

/** PutEvents takes at most 10 entries and 256 KB per call. */
export const MAX_ENTRIES = 10;
export const MAX_BYTES = 256 * 1024;

const BUS_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@*-]{0,1599}$/;
/** A profile or region goes into an argv: no leading dash, no odd characters. */
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:/+-]{0,127}$/;

/** `target` as it goes into the aws argv: a profile or region that is not a plain name is refused. */
export function checkTarget(t: AwsTarget): AwsTarget {
  for (const [what, v] of [['profile', t.profile], ['region', t.region]] as const) {
    if (v !== undefined && !TARGET_RE.test(v)) throw new EventsError(`not a valid ${what} name: "${v}"`);
  }
  return t;
}

/** The size EventBridge counts for an entry: time (14 bytes), source, detail type, detail and resources, as UTF-8. */
export function entrySize(e: PutEntry): number {
  const len = (s: string): number => Buffer.byteLength(s, 'utf8');
  return (e.Time ? 14 : 0) + len(e.Source) + len(e.DetailType) + len(e.Detail) + (e.Resources ?? []).reduce((n, r) => n + len(r), 0);
}

/** Check one event and make its entry. `label` names it in errors ("event 3"). */
export function buildEntry(input: EventInput, label = 'the event'): PutEntry {
  const bad = (m: string): EventsError => new EventsError(`${label}: ${m}`);
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const detailType = typeof input.detailType === 'string' ? input.detailType.trim() : '';
  if (!source) throw bad('a source is required');
  if (source.toLowerCase().startsWith('aws.')) throw bad(`the source "${source}" is reserved for AWS services (use your own, e.g. "acme.orders")`);
  if (!detailType) throw bad('a detail-type is required');
  const d: unknown = input.detail;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) throw bad('the detail must be a JSON object');
  if (input.bus !== undefined && !BUS_RE.test(input.bus)) throw bad(`not a valid event bus name or ARN: "${input.bus}"`);
  for (const r of input.resources ?? []) if (typeof r !== 'string' || r === '') throw bad('a resource must be a non-empty string (an ARN)');

  // Rows can hold bigint (database drivers); JSON has no such type, so it goes in as text.
  const entry: PutEntry = {
    Source: source,
    DetailType: detailType,
    Detail: JSON.stringify(d, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  };
  if (input.bus !== undefined) entry.EventBusName = input.bus;
  if (input.resources && input.resources.length) entry.Resources = [...input.resources];
  if (input.time !== undefined) {
    const t = new Date(input.time);
    if (Number.isNaN(t.getTime())) throw bad(`not a valid time: "${input.time}" (use ISO 8601, e.g. 2026-11-24T15:00:00Z)`);
    entry.Time = t.toISOString();
  }
  const size = entrySize(entry);
  if (size > MAX_BYTES) throw bad(`it is ${size} bytes; EventBridge accepts at most ${MAX_BYTES} (256 KB) per event`);
  return entry;
}

export function buildEntries(inputs: readonly EventInput[]): PutEntry[] {
  return inputs.map((e, i) => buildEntry(e, inputs.length === 1 ? 'the event' : `event ${i + 1}`));
}

/** Split into calls of at most 10 entries and 256 KB (counted the way EventBridge counts). */
export function chunkEntries(entries: readonly PutEntry[]): PutEntry[][] {
  const chunks: PutEntry[][] = [];
  let cur: PutEntry[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = entrySize(e);
    if (cur.length > 0 && (cur.length >= MAX_ENTRIES || bytes + size > MAX_BYTES)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** `aws events put-events --entries file://<file>`; a file because one argument cannot hold 256 KB on every system. */
export function putEventsArgv(entriesFile: string, t: AwsTarget): string[] {
  return ['aws', 'events', 'put-events', '--entries', `file://${entriesFile}`, '--output', 'json', ...awsGlobalArgs(t)];
}

export interface PutFailure {
  /** Position within the call. */
  index: number;
  code: string;
  message: string;
}

export interface PutResult {
  ids: string[];
  failures: PutFailure[];
}

/** Read the answer of one call. `put-events` exits 0 when some entries failed, so the counts are the truth. */
export function parsePutResult(stdout: string, expected: number): PutResult {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new EventsError('unexpected output from aws events put-events');
  }
  const o = body as { FailedEntryCount?: unknown; Entries?: unknown } | null;
  if (!o || !Array.isArray(o.Entries) || o.Entries.length !== expected) throw new EventsError('aws events put-events answered with the wrong number of entries');
  const ids: string[] = [];
  const failures: PutFailure[] = [];
  o.Entries.forEach((raw, index) => {
    const e = (raw ?? {}) as { EventId?: unknown; ErrorCode?: unknown; ErrorMessage?: unknown };
    if (typeof e.ErrorCode === 'string') failures.push({ index, code: e.ErrorCode, message: typeof e.ErrorMessage === 'string' ? e.ErrorMessage : '' });
    else if (typeof e.EventId === 'string') ids.push(e.EventId);
    else failures.push({ index, code: 'Unknown', message: 'no event id in the answer' });
  });
  return { ids, failures };
}

export interface SendReport {
  /** Events EventBridge accepted. */
  sent: number;
  ids: string[];
  /** Position of a failed event within all the events, with what EventBridge said. */
  failures: PutFailure[];
  /** Set when sending stopped on an error of the aws call itself. */
  error?: string;
}

export interface SendOptions {
  dryRun?: boolean;
  /** One line per call, as it goes. */
  log?: (line: string) => void;
}

/**
 * Send the events, one call per chunk, stopping at the first call that fails or has a failed entry. Events
 * already accepted stay sent: EventBridge has no rollback, so the report says how many went.
 */
export async function sendEntries(entries: readonly PutEntry[], target: AwsTarget, opts: SendOptions = {}): Promise<SendReport> {
  checkTarget(target);
  const report: SendReport = { sent: 0, ids: [], failures: [] };
  if (opts.dryRun) return report;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-events-'));
  try {
    let offset = 0;
    for (const chunk of chunkEntries(entries)) {
      const file = path.join(dir, `entries-${randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(file, JSON.stringify(chunk), { mode: 0o600 });
      const r = await awsRun(putEventsArgv(file, target));
      if (!r.ok) {
        report.error = r.timedOut ? 'aws events put-events timed out' : r.stderr || 'aws events put-events failed';
        return report;
      }
      let result: PutResult;
      try {
        result = parsePutResult(r.stdout, chunk.length);
      } catch (e) {
        report.error = e instanceof Error ? e.message : String(e);
        return report;
      }
      report.sent += result.ids.length;
      report.ids.push(...result.ids);
      report.failures.push(...result.failures.map((f) => ({ ...f, index: f.index + offset })));
      opts.log?.(`sent ${report.sent} of ${entries.length} events`);
      if (result.failures.length) return report;
      offset += chunk.length;
    }
    return report;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A failed report as one error message (what the command and the adapter show). */
export function describeFailure(r: SendReport, total: number): string {
  const lines: string[] = [];
  if (r.error) lines.push(r.error);
  for (const f of r.failures.slice(0, 5)) lines.push(`event ${f.index + 1}: ${f.code}${f.message ? ` - ${f.message}` : ''}`);
  if (r.failures.length > 5) lines.push(`... and ${r.failures.length - 5} more`);
  lines.push(`${r.sent} of ${total} events were sent (EventBridge cannot take them back)`);
  return lines.join('\n');
}
