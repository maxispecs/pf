import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from '@pulpfixer/plugin-db/api';
import { assertTableAllowed, blockedTable, guarded } from './guard.mjs';

test('blockedTable finds auth and token tables in any statement shape', () => {
  for (const s of [
    'SELECT * FROM "iris-auth-staging" WHERE pk = ?',
    'SELECT * FROM "staging-PGx-auth"."gsi-auth-user" WHERE x = ?',
    'SELECT * FROM staging_auth WHERE pk = ?',
    'select * from "STAGING-AUTH"',
    'SELECT * FROM "staging-HealthAgentRefreshTokens" WHERE token_id = ?',
    `INSERT INTO "prod-refresh_token" VALUE {'a': ?}`,
    'UPDATE "x-AUTH-y" SET a = ? WHERE pk = ?',
    'DELETE FROM "auth" WHERE pk = ?',
    'SELECT * FROM "ok" WHERE EXISTS(SELECT 1 FROM "other-auth")',
  ]) assert.ok(blockedTable(s), s);
});

test('other tables and columns that merely look similar pass', () => {
  for (const s of [
    'SELECT 1',
    'SELECT * FROM "staging-HealthAgentUsers" WHERE user_id = ?',
    'SELECT author, authorized FROM "staging-HealthAgentEvents" WHERE event_id = ?',
    'SELECT * FROM "staging-HealthAgentDailyMetrics" WHERE user_id = ?',
    'SELECT * FROM "LetterStorage"."status-index" WHERE status = ?',
  ]) assert.equal(blockedTable(s), null, s);
});

test('assertTableAllowed checks insert / update / delete table names', () => {
  assert.throws(() => assertTableAllowed('iris-auth-staging'), /excluded table/);
  assert.doesNotThrow(() => assertTableAllowed('staging-HealthAgentUsers'));
});

test('a guarded Db refuses blocked statements before the database is called, and passes the rest through', async () => {
  const calls = [];
  const fake = new Proxy({ dialect: 'dynamodb', name: 'x' }, { get: (t, k) => (k in t ? t[k] : (...a) => (calls.push(String(k)), Promise.resolve([]))) });
  const db = guarded(fake);
  assert.throws(() => db.all(sql`SELECT * FROM ${sql.id('iris-auth-staging')} WHERE pk = ${'a'}`), /excluded table/);
  assert.throws(() => db.one('SELECT * FROM "staging-HealthAgentRefreshTokens"'), /excluded table/);
  assert.throws(() => db.insert('staging-PGx-auth', { PK: 'a' }), /excluded table/);
  assert.throws(() => db.deleteFrom('iris-auth-staging', { pk: 'a' }), /excluded table/);
  assert.deepEqual(calls, [], 'nothing reached the database');
  await db.all(sql`SELECT * FROM ${sql.id('staging-HealthAgentUsers')} WHERE user_id = ${'a'}`);
  assert.deepEqual(calls, ['all']);
});
