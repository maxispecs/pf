// One place that opens a DynamoDB connection saved with `pf db add` (see `pf db list`).
import { registerDbDrivers } from '@pulpfixer/kit/db';
import dynamodb from '@pulpfixer/db-dynamodb';
import { connect } from '@pulpfixer/plugin-db/api';
import { guarded } from './guard.mjs';

// pf registers its drivers itself; a plain node script has to.
registerDbDrivers(dynamodb.dbDrivers);

export const CONNECTION = process.env.DDB_CONNECTION ?? 'sdlc-ddb';

/**
 * Open a saved connection. Read-only unless you ask: with `writes: 'deny'` an insert, update, delete or
 * exec throws before anything is sent. `{ writes: 'allow' }` changes data on purpose, `{ writes: 'dry' }`
 * only reports what would be sent. Pass `{ connection: 'name' }` to use another saved connection.
 * Auth and token tables are excluded (lib/guard.mjs): statements that name one are refused before anything is sent.
 * Close it when done (`await db.close()`).
 */
export const openDb = async ({ connection, ...opts } = {}) => guarded(await connect(connection ?? CONNECTION, { writes: 'deny', ...opts }));
