import { buildEntry, describeFailure, EventsError, hasAws, sendEntries, type PutEntry, type SendReport } from '@pulpfixer/plugin-aws/api';
import { loadPublishers, publisherName, readIdentity, repoRootOf, requireIdentity, type Identity, type Publisher } from './config.js';
import { buildEvent, type EventMeta, type MetaOptions } from './envelope.js';
import { CriError } from './errors.js';
import { checkRoute, selectPublisher } from './select.js';

export interface DispatchOptions extends MetaOptions {
  /** The stack identity. Default: the `cri` section of the `pulpfixer.json` of the repo around `cwd`. */
  identity?: Identity;
  /** The publishers to choose from. Default: `~/.pf/cri/publishers.json`. */
  publishers?: readonly Publisher[];
  /** Where to look for the repo identity. Default: the current directory. */
  cwd?: string;
  /** Check and build the event but send nothing. */
  dryRun?: boolean;
  /** The clock (tests). */
  now?: () => Date;
  /** How entries go out. Default: plugin-aws's `put-events`. */
  send?: (entries: PutEntry[], target: { profile?: string; region?: string }) => Promise<SendReport>;
}

/** The acknowledgement of a dispatch (spec: the result is the publisher acknowledgement). */
export interface DispatchResult {
  /** Event id of `_meta`: the receiver uses it to drop redeliveries. */
  id: string;
  /** The id EventBridge gave the event, the transport acknowledgement. Absent on a dry run. */
  eventId?: string;
  route: string;
  /** The prefix of the publisher that took it, or `default`. */
  publisher: string;
  bus: string;
  source: string;
  meta: EventMeta;
  /** The entry that was (or, on a dry run, would be) sent. */
  entry: PutEntry;
  dryRun: boolean;
}

/** What `dispatch` decided before sending: used by the command to show the event first. */
export type PreparedDispatch = Omit<DispatchResult, 'eventId' | 'dryRun'> & { target: { profile?: string; region?: string } };

/** Select the publisher and build the event, without sending. Throws a `CriError` for any problem with it. */
export function prepareDispatch(route: string, payload: unknown, opts: DispatchOptions = {}): PreparedDispatch {
  checkRoute(route);
  const publishers = opts.publishers ?? loadPublishers();
  const publisher = selectPublisher(publishers, route);
  const identity = opts.identity ?? requireIdentity(readIdentity(repoRootOf(opts.cwd)));
  const { input, meta } = buildEvent({
    route,
    payload,
    publisher,
    identity,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    ...(opts.causationId !== undefined ? { causationId: opts.causationId } : {}),
    ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
    ...(opts.hash !== undefined ? { hash: opts.hash } : {}),
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    ...(opts.now ? { now: opts.now() } : {}),
  });
  let entry: PutEntry;
  try {
    entry = buildEntry(input);
  } catch (e) {
    if (e instanceof EventsError) throw new CriError(e.message.replace(/^the event: /, 'the event '));
    throw e;
  }
  return {
    id: meta.id,
    route,
    publisher: publisherName(publisher),
    bus: publisher.bus,
    source: entry.Source,
    meta,
    entry,
    target: { ...(publisher.profile ? { profile: publisher.profile } : {}), ...(publisher.region ? { region: publisher.region } : {}) },
  };
}

/** Send a prepared event. */
export async function sendPrepared(p: PreparedDispatch, opts: Pick<DispatchOptions, 'dryRun' | 'send'> = {}): Promise<DispatchResult> {
  const { target, ...rest } = p;
  if (opts.dryRun) return { ...rest, dryRun: true };
  if (!opts.send && !hasAws()) throw new CriError('the aws CLI is not on PATH', 'install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
  const report = await (opts.send ?? ((entries, t) => sendEntries(entries, t)))([p.entry], target);
  if (report.error || report.failures.length || report.sent !== 1 || !report.ids[0]) {
    throw new CriError(`the event ${p.id} on "${p.route}" was not sent\n${describeFailure(report, 1)}`, p.target.profile ? `check the AWS profile "${p.target.profile}" and events:PutEvents on ${p.bus}` : `check the AWS credentials and events:PutEvents on ${p.bus}`);
  }
  return { ...rest, eventId: report.ids[0], dryRun: false };
}

/**
 * Send an event to a route with a payload through the publisher the route selects (landscape spec,
 * "One dispatch(route, payload) helper"). Resolves with the acknowledgement; rejects with a `CriError`
 * for a missing publisher or identity, a bad payload or a send the transport did not accept.
 */
export async function dispatch(route: string, payload: unknown = {}, opts: DispatchOptions = {}): Promise<DispatchResult> {
  return sendPrepared(prepareDispatch(route, payload, opts), opts);
}

/** `dispatch`, for fire and forget callers (the same call, named for what the caller expects: no result). */
export const emit = dispatch;
