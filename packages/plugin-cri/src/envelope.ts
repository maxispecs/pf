import { randomBytes, randomUUID } from 'node:crypto';
import type { EventInput } from '@pulpfixer/plugin-aws/api';
import type { Identity, Publisher } from './config.js';
import { CriError } from './errors.js';

/** The `_meta` key of the transport payload (serialization spec). Reserved: user payloads may not set it. */
export const META_KEY = '_meta';
/** The envelope format version carried in `_meta.version`. */
export const ENVELOPE_VERSION = 1;

export interface EventMeta {
  id: string;
  correlation_id: string;
  causation_id?: string;
  hash?: string;
  topic_id?: string;
  source_domain: string;
  source_stack: string;
  version: number;
}

/** What the caller may set on the envelope; everything else is made by the publisher. */
export interface MetaOptions {
  /** Shared by all events of one request chain. A new `corr_<hex>` when not given. */
  correlationId?: string;
  /** `id` of the event whose consumer dispatches this one. */
  causationId?: string;
  /** Groups related events (a conversation, entity stream or saga). */
  topicId?: string;
  /** Idempotency key. */
  hash?: string;
  /** Use this event id instead of a new UUID (a retry of the same event). */
  id?: string;
}

export interface BuildEventInput extends MetaOptions {
  route: string;
  payload: unknown;
  publisher: Publisher;
  identity: Identity;
  now?: Date;
}

export interface BuiltEvent {
  /** What plugin-aws turns into a `put-events` entry. */
  input: EventInput;
  meta: EventMeta;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function checkId(what: string, v: string): string {
  if (!ID_RE.test(v)) throw new CriError(`${what} "${v}" must be letters, digits, ".", "_", ":" or "-" (at most 128, starting with a letter or digit)`);
  return v;
}

/** The payload as a plain object without `_meta`, or a `CriError`. */
export function checkPayload(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new CriError('the payload must be a JSON object (the arguments of the target method)');
  if (META_KEY in (payload as object)) {
    throw new CriError(`the payload may not have a top-level "${META_KEY}" key: it is reserved for the event metadata the publisher adds`);
  }
  return payload as Record<string, unknown>;
}

/**
 * Map an event onto an EventBridge entry (landscape spec, "EventBridge Mapping"): the route is the
 * detail-type unchanged, the detail is the flat payload plus `_meta`, the source is the publisher's
 * `source` or else the stack name, the time is the dispatch time.
 */
export function buildEvent(i: BuildEventInput): BuiltEvent {
  const payload = checkPayload(i.payload);
  const meta: EventMeta = {
    id: i.id !== undefined ? checkId('the event id', i.id) : randomUUID(),
    correlation_id: i.correlationId !== undefined ? checkId('the correlation id', i.correlationId) : `corr_${randomBytes(6).toString('hex')}`,
    ...(i.causationId !== undefined ? { causation_id: checkId('the causation id', i.causationId) } : {}),
    ...(i.hash !== undefined ? { hash: checkId('the hash', i.hash) } : {}),
    ...(i.topicId !== undefined ? { topic_id: checkId('the topic id', i.topicId) } : {}),
    source_domain: i.identity.domain,
    source_stack: i.identity.stack,
    version: ENVELOPE_VERSION,
  };
  const input: EventInput = {
    source: i.publisher.source ?? i.identity.stack,
    detailType: i.route,
    detail: { ...payload, [META_KEY]: meta },
    bus: i.publisher.bus,
    time: (i.now ?? new Date()).toISOString(),
  };
  return { input, meta };
}
