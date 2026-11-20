import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findForm, validateDbDriver } from '@pulpfixer/kit/db';
import plugin, { clientFor, dynamodbDriver, makeDynamoSession } from '../src/index.js';
import { DynamoClient } from '../src/client.js';
import { err, fakeDynamo, type Handler } from './fake-dynamo.js';

const q = (text: string, ...values: unknown[]) => ({ text, values });

test('the plugin carries a valid driver', () => {
  assert.equal(plugin.api, 2);
  assert.equal(plugin.name, 'db-dynamodb');
  assert.deepEqual(plugin.dbDrivers?.map((d) => d.id), ['dynamodb']);
  assert.equal(validateDbDriver(dynamodbDriver), null);
  assert.equal(dynamodbDriver.dialect, 'dynamodb');
});

test('forms: the only secret field is the secret access key, so --secret-from covers it', () => {
  const secrets = (id: string) => findForm(dynamodbDriver, id)!.fields.filter((f) => f.kind === 'secret').map((f) => f.key);
  assert.deepEqual(secrets('profile'), []);
  assert.deepEqual(secrets('keys'), ['secretAccessKey']);
  assert.equal(dynamodbDriver.forms[0]!.id, 'profile');
});

test('describe shows where and how, never a secret', () => {
  assert.equal(dynamodbDriver.describe('profile', { region: 'eu-west-1', profile: 'acme' }), 'dynamodb eu-west-1 (profile acme)');
  assert.equal(dynamodbDriver.describe('profile', { region: 'eu-west-1' }), 'dynamodb eu-west-1 (environment credentials)');
  assert.equal(dynamodbDriver.describe('profile', { region: 'local', endpoint: 'http://localhost:8000' }), 'dynamodb local at localhost:8000 (environment credentials)');
  const keys = dynamodbDriver.describe('keys', { region: 'eu-west-1', accessKeyId: 'AKIAEXAMPLE1', secretAccessKey: 'TOPSECRET' });
  assert.equal(keys, 'dynamodb eu-west-1 (access key)');
  assert.equal(dynamodbDriver.describe('profile', { region: 'eu-west-1', endpoint: 'http://evil.example.com' }), 'dynamodb eu-west-1 at an invalid endpoint (environment credentials)');
});

test('clientFor refuses an incomplete connection', () => {
  assert.throws(() => clientFor('profile', {}), /no region/);
  assert.throws(() => clientFor('keys', { region: 'eu-west-1', accessKeyId: 'AKIAEXAMPLE1' }), /secret access key/);
  assert.throws(() => clientFor('profile', { region: 'eu-west-1', endpoint: 'http://example.com' }), /localhost/);
});

async function withSession<T>(handler: Handler, fn: (s: ReturnType<typeof makeDynamoSession>, seen: Awaited<ReturnType<typeof fakeDynamo>>['seen']) => Promise<T>, extra: object = {}): Promise<T> {
  const srv = await fakeDynamo(handler);
  try {
    const client = new DynamoClient({ region: 'eu-west-1', endpoint: srv.endpoint, credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-secret' }), ...extra });
    return await fn(makeDynamoSession(client), srv.seen);
  } finally {
    await srv.close();
  }
}

test('the driver connects through the keys form and runs a query', async () => {
  const srv = await fakeDynamo(() => ({ json: { Items: [{ pk: { S: 'a' } }] } }), 'SECRETKEY');
  try {
    const session = await dynamodbDriver.connect('keys', { region: 'eu-west-1', endpoint: srv.endpoint, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'SECRETKEY' });
    assert.deepEqual(await session.execute(q('SELECT * FROM "t"')), { rows: [{ pk: 'a' }] });
    assert.equal(srv.seen[0]!.signatureOk, true);
    await session.close();
  } finally {
    await srv.close();
  }
});

test('reads return rows; insert and update report one changed item', async () => {
  await withSession(() => ({ json: {} }), async (s) => {
    assert.deepEqual(await s.execute(q('SELECT * FROM "t"')), { rows: [] });
    assert.deepEqual(await s.execute(q(`INSERT INTO "t" VALUE {'pk': ?}`, 'a')), { rows: [], affected: 1 });
    assert.deepEqual(await s.execute(q('UPDATE "t" SET n = ? WHERE pk = ?', 1, 'a')), { rows: [], affected: 1 });
  });
});

test('DELETE reports a count only when RETURNING gave the item back', async () => {
  await withSession((seen) => ({ json: /RETURNING/.test(String(seen.body.Statement)) ? { Items: [{ pk: { S: 'a' } }] } : {} }), async (s) => {
    assert.deepEqual(await s.execute(q('DELETE FROM "t" WHERE pk = ?', 'a')), { rows: [] });
    assert.deepEqual(await s.execute(q('DELETE FROM "t" WHERE pk = ? RETURNING ALL OLD *', 'a')), { rows: [{ pk: 'a' }], affected: 1 });
  });
});

test('a transaction queues its writes and sends them as one ExecuteTransaction', async () => {
  await withSession(() => ({ json: {} }), async (s, seen) => {
    const out = await s.transaction(async (tx) => {
      await tx.execute(q(`INSERT INTO "t" VALUE {'pk': ?}`, 'a'));
      await tx.transaction(async (inner) => void (await inner.execute(q('DELETE FROM "t" WHERE pk = ?', 'b'))));
      assert.equal(seen.length, 0, 'nothing is sent before the transaction ends');
      return 'done';
    });
    assert.equal(out, 'done');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.operation, 'ExecuteTransaction');
    assert.equal((seen[0]!.body.TransactStatements as unknown[]).length, 2);
  });
});

test('a transaction that throws sends nothing; a read inside is refused', async () => {
  await withSession(() => ({ json: {} }), async (s, seen) => {
    await assert.rejects(() => s.transaction(async (tx) => {
      await tx.execute(q(`INSERT INTO "t" VALUE {'pk': ?}`, 'a'));
      throw new Error('stop');
    }), /stop/);
    await assert.rejects(() => s.transaction((tx) => tx.execute(q('SELECT * FROM "t"'))), /only hold writes/);
    assert.equal(seen.length, 0);
  });
});

test('a failed transaction surfaces the AWS error', async () => {
  await withSession(() => err('TransactionCanceledException', 'Transaction cancelled, please refer cancellation reasons'), async (s) => {
    await assert.rejects(() => s.transaction((tx) => tx.execute(q('DELETE FROM "t" WHERE pk = ?', 'a'))), /TransactionCanceledException/);
  });
});

test('SELECT 1 (the pf db connection check) pings DynamoDB instead of sending invalid PartiQL', async () => {
  await withSession(() => ({ json: { TableNames: [] } }), async (s, seen) => {
    assert.deepEqual(await s.execute(q('SELECT 1')), { rows: [{ '1': 1 }] });
    assert.equal(seen[0]!.operation, 'ListTables');
    assert.deepEqual(seen[0]!.body, { Limit: 1 });
    assert.equal(seen[0]!.signatureOk, true);
  });
});

test('the ping accepts AccessDenied (signed and understood) but not a bad key or expired token', async () => {
  await withSession(() => err('AccessDeniedException', 'not authorized to perform dynamodb:ListTables'), async (s) => {
    assert.deepEqual(await s.execute(q('SELECT 1')), { rows: [{ '1': 1 }] });
  });
  await withSession(() => err('UnrecognizedClientException', 'The security token included in the request is invalid.'), async (s) => {
    await assert.rejects(() => s.execute(q('SELECT 1')), /UnrecognizedClientException/);
  });
  await withSession(() => err('ExpiredTokenException', 'expired'), async (s) => {
    await assert.rejects(() => s.execute(q('SELECT 1')), /ExpiredTokenException/);
  });
});

test('a SELECT with values or a real query is never mistaken for the ping', async () => {
  await withSession(() => ({ json: { Items: [] } }), async (s, seen) => {
    await s.execute(q('SELECT 1 FROM "t"'));
    await s.execute(q('SELECT ?', 1));
    assert.deepEqual(seen.map((x) => x.operation), ['ExecuteStatement', 'ExecuteStatement']);
  });
});
