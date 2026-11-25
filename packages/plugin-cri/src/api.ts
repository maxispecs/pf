/**
 * What services and scripts import (`@pulpfixer/plugin-cri/api`): `dispatch(route, payload)` sends an event
 * through the publisher its route selects. Publishers are configured with `pf cri publisher add`; the stack
 * identity with `pf cri identity` (or passed as options).
 */
export { dispatch, emit, prepareDispatch, sendPrepared, type DispatchOptions, type DispatchResult, type PreparedDispatch } from './dispatch.js';
export { buildEvent, checkPayload, ENVELOPE_VERSION, META_KEY, type BuiltEvent, type EventMeta, type MetaOptions } from './envelope.js';
export { loadPublishers, publisherName, publishersPath, readIdentity, validatePublisher, type Identity, type Publisher } from './config.js';
export { checkRoute, selectPublisher } from './select.js';
export { CriError } from './errors.js';
