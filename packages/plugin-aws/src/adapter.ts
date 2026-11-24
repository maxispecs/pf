import { ioRef, type IoAdapter, type IoContext, type IoRef, type IoSink, type Row } from '@pulpfixer/kit/io';
import { buildEntry, checkTarget, describeFailure, EventsError, sendEntries, type PutEntry } from './events.js';

export interface EventBridgeSinkConfig {
  /** The `source` of every event (not `aws.*`). */
  source: string;
  /** The `detail-type` of every event. Give this or `detailTypeField`. */
  detailType?: string;
  /** The column that holds each row's detail-type. */
  detailTypeField?: string;
  /** What goes into the event's detail: the whole row (default) or only these columns. */
  detail?: 'row' | string[];
  /** A bus name or ARN. Without one the account's default bus gets the events. */
  bus?: string;
  resources?: string[];
  profile?: string;
  region?: string;
}

/** More events than this are refused: they are held until the pipe has worked, so split a bigger pipe. */
export const MAX_BUFFERED_EVENTS = 100_000;

function checkConfig(config: unknown): EventBridgeSinkConfig {
  const c = config as Partial<EventBridgeSinkConfig> | null;
  if (!c || typeof c !== 'object') throw new EventsError('the eventbridge sink needs a configuration object');
  if (typeof c.source !== 'string' || c.source.trim() === '') throw new EventsError('the eventbridge sink needs a source (for example "acme.orders")');
  if ((c.detailType === undefined) === (c.detailTypeField === undefined)) throw new EventsError('the eventbridge sink needs detailType or detailTypeField, not both and not neither');
  if (c.detailType !== undefined && typeof c.detailType !== 'string') throw new EventsError('detailType must be a string');
  if (c.detailTypeField !== undefined && (typeof c.detailTypeField !== 'string' || c.detailTypeField === '')) throw new EventsError('detailTypeField must be a column name');
  if (c.detail !== undefined && c.detail !== 'row' && !(Array.isArray(c.detail) && c.detail.length > 0 && c.detail.every((n) => typeof n === 'string' && n !== ''))) {
    throw new EventsError('detail must be "row" or a list of column names');
  }
  if (c.resources !== undefined && !(Array.isArray(c.resources) && c.resources.every((r) => typeof r === 'string'))) throw new EventsError('resources must be a list of ARNs');
  for (const k of ['bus', 'profile', 'region'] as const) if (c[k] !== undefined && typeof c[k] !== 'string') throw new EventsError(`${k} must be a string`);
  // Check source, bus and resources the way an event is checked, and the target as it goes into the aws argv.
  buildEntry({ source: c.source, detailType: c.detailType ?? 'check', detail: {}, ...(c.bus !== undefined ? { bus: c.bus } : {}), ...(c.resources ? { resources: c.resources } : {}) }, 'eventbridge sink');
  checkTarget({ ...(c.profile !== undefined ? { profile: c.profile } : {}), ...(c.region !== undefined ? { region: c.region } : {}) });
  return c as EventBridgeSinkConfig;
}

/** One row as an event; `n` is its 1-based position, for errors. */
function rowEvent(c: EventBridgeSinkConfig, row: Row, n: number): PutEntry {
  let detail: Record<string, unknown>;
  if (Array.isArray(c.detail)) {
    detail = {};
    for (const k of c.detail) {
      if (!(k in row)) throw new EventsError(`row ${n} has no column "${k}"`);
      detail[k] = row[k];
    }
  } else {
    detail = { ...row };
  }
  let detailType = c.detailType;
  if (c.detailTypeField !== undefined) {
    const v = row[c.detailTypeField];
    if (typeof v !== 'string' || v.trim() === '') throw new EventsError(`row ${n}: the column "${c.detailTypeField}" holds no detail-type`);
    detailType = v;
  }
  return buildEntry(
    { source: c.source, detailType: detailType!, detail, ...(c.bus !== undefined ? { bus: c.bus } : {}), ...(c.resources ? { resources: c.resources } : {}) },
    `row ${n}`,
  );
}

async function openSink(config: unknown, io: IoContext): Promise<IoSink> {
  const c = checkConfig(config);
  const target = { ...(c.profile !== undefined ? { profile: c.profile } : {}), ...(c.region !== undefined ? { region: c.region } : {}) };
  const bus = c.bus ?? 'the default bus';
  const entries: PutEntry[] = [];
  return {
    async write(batch) {
      for (const row of batch) {
        if (entries.length >= MAX_BUFFERED_EVENTS) throw new EventsError(`more than ${MAX_BUFFERED_EVENTS} events in one pipe: they are sent when it has worked, so split the pipe`);
        entries.push(rowEvent(c, row, entries.length + 1));
      }
    },
    async close(ok) {
      if (!ok) return;
      if (entries.length === 0) return io.log(io.dryRun ? `would send no events to ${bus}` : 'no events to send');
      if (io.dryRun) return io.log(`would send ${entries.length} event${entries.length === 1 ? '' : 's'} to ${bus}`);
      const report = await sendEntries(entries, target, { log: io.log });
      if (report.error || report.failures.length) throw new EventsError(describeFailure(report, entries.length));
    },
  };
}

/**
 * Amazon EventBridge as an output: each row is one event. Events are checked as the rows arrive and sent
 * (10 per `put-events` call, through the aws CLI) when the pipe has worked, so a failed pipe sends nothing.
 * EventBridge cannot take events back: when a call fails part-way, the error says how many were sent.
 */
export const eventbridgeAdapter: IoAdapter<EventBridgeSinkConfig> = {
  id: 'eventbridge',
  label: 'Amazon EventBridge',
  describe(config) {
    const c = config as Partial<EventBridgeSinkConfig> | null;
    if (!c || typeof c !== 'object' || typeof c.source !== 'string') return 'eventbridge (?)';
    return `eventbridge ${c.bus ?? 'default bus'} (source ${c.source})`;
  },
  sink: openSink,
};

/** An output that sends one event per row to EventBridge. */
export const eventbridgeSink = (config: EventBridgeSinkConfig): IoRef<EventBridgeSinkConfig> => ioRef('eventbridge', config);
