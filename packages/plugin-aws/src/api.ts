/**
 * The API for pipe packages (`@pulpfixer/pipe-<name>`): `eventbridgeSink` declares Amazon EventBridge as an
 * output, one event per row (see `@pulpfixer/plugin-io/api` for `definePipes` and the chain helpers).
 * Also what `@pulpfixer/plugin-cri` builds on: the checked event entry and the `put-events` sender.
 */
export { eventbridgeAdapter, eventbridgeSink, MAX_BUFFERED_EVENTS, type EventBridgeSinkConfig } from './adapter.js';
export {
  buildEntry,
  checkTarget,
  describeFailure,
  EventsError,
  sendEntries,
  type EventInput,
  type PutEntry,
  type SendOptions,
  type SendReport,
} from './events.js';
export { hasAws, type AwsTarget } from './aws.js';
