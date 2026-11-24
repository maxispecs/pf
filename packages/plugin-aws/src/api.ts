/**
 * The API for pipe packages (`@pulpfixer/pipe-<name>`): `eventbridgeSink` declares Amazon EventBridge as an
 * output, one event per row (see `@pulpfixer/plugin-io/api` for `definePipes` and the chain helpers).
 */
export { eventbridgeAdapter, eventbridgeSink, MAX_BUFFERED_EVENTS, type EventBridgeSinkConfig } from './adapter.js';
export { EventsError, type EventInput } from './events.js';
