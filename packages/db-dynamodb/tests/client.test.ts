import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamoClient, DynamoError, resolveTarget } from '../src/client.js';
import { err, fakeDynamo } from './fake-dynamo.js';

const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-secret' });
const client = (endpoint: string, extra: object = {}) => new DynamoClient({ region: 'eu-west-1', endpoint, credentials: creds, ...extra });

test('execute sends a signed ExecuteStatement with bound parameters and decodes items', async () => {
  const srv = await fakeDynamo(() => ({ json: { Items: [{ pk: { S: 'a' }, n: { N: '3' } }] } }));
  try {
    const rows = await client(srv.endpoint).execute('SELECT * FROM "t" WHERE pk = ? AND n > ?', ['a', 2]);
    assert.deepEqual(rows, [{ pk: 'a', n: 3 }]);
    const s = srv.seen[0]!;
    assert.equal(s.signatureOk, true);
    assert.equal(s.operation, 'ExecuteStatement');
    assert.equal(s.headers['content-type'], 'application/x-amz-json-1.0');
    assert.deepEqual(s.body, { Statement: 'SELECT * FROM "t" WHERE pk = ? AND n > ?', Parameters: [{ S: 'a' }, { N: '2' }], ConsistentRead: true });
    assert.match(String(s.headers.authorization), /Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/dynamodb\/aws4_request/);
  } finally {
    await srv.close();
  }
});

test('a statement without values sends no Parameters, and consistency can be turned off', async () => {
  const srv = await fakeDynamo(() => ({ json: {} }));
  try {
    assert.deepEqual(await client(srv.endpoint, { consistentRead: false }).execute('SELECT * FROM "t"', []), []);
    assert.deepEqual(srv.seen[0]!.body, { Statement: 'SELECT * FROM "t"', ConsistentRead: false });
  } finally {
    await srv.close();
  }
});

test('execute follows NextToken through every page', async () => {
  const srv = await fakeDynamo((s, n) =>
    n === 1 ? { json: { Items: [], NextToken: 'p2' } } : n === 2 ? { json: { Items: [{ a: { N: '1' } }], NextToken: 'p3' } } : { json: { Items: [{ a: { N: '2' } }] } },
  );
  try {
    assert.deepEqual(await client(srv.endpoint).execute('SELECT * FROM "t"', []), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(srv.seen.map((s) => s.body.NextToken), [undefined, 'p2', 'p3']);
  } finally {
    await srv.close();
  }
});

test('more items than maxItems is an error, not a silent cut', async () => {
  const srv = await fakeDynamo(() => ({ json: { Items: [{ a: { N: '1' } }, { a: { N: '2' } }, { a: { N: '3' } }] } }));
  try {
    await assert.rejects(() => client(srv.endpoint, { maxItems: 2 }).execute('SELECT * FROM "t"', []), (e: DynamoError) => e.code === 'TooManyItems' && /more than 2 items/.test(e.message));
  } finally {
    await srv.close();
  }
});

test('AWS errors keep their name and message; nothing else is leaked', async () => {
  const srv = await fakeDynamo(() => err('ResourceNotFoundException', 'Requested resource not found'));
  try {
    await assert.rejects(
      () => client(srv.endpoint).execute('SELECT * FROM "nope" WHERE pk = ?', ['secret-value']),
      (e: DynamoError) => e.code === 'ResourceNotFoundException' && e.status === 400 && e.message === 'ResourceNotFoundException: Requested resource not found' && !e.message.includes('secret-value'),
    );
  } finally {
    await srv.close();
  }
});

test('throttling is retried, other errors are not', async () => {
  const srv = await fakeDynamo((s, n) => (n < 3 ? err('ThrottlingException', 'slow down') : { json: { Items: [] } }));
  try {
    assert.deepEqual(await client(srv.endpoint).execute('SELECT * FROM "t"', []), []);
    assert.equal(srv.seen.length, 3);
  } finally {
    await srv.close();
  }
  const bad = await fakeDynamo(() => err('InternalServerError', 'oops', 500));
  try {
    await assert.rejects(() => client(bad.endpoint).execute('UPDATE "t" SET n = n + 1 WHERE pk = ?', ['a']), /InternalServerError/);
    assert.equal(bad.seen.length, 1, 'a 5xx may have been applied: it must not be sent again');
  } finally {
    await bad.close();
  }
});

test('throttling gives up after the retry limit', async () => {
  const srv = await fakeDynamo(() => err('ProvisionedThroughputExceededException', 'limit'));
  try {
    await assert.rejects(() => client(srv.endpoint, { retries: 1 }).execute('SELECT * FROM "t"', []), /ProvisionedThroughputExceeded/);
    assert.equal(srv.seen.length, 2);
  } finally {
    await srv.close();
  }
});

test('an expired token invalidates the credentials and is retried once', async () => {
  const srv = await fakeDynamo((s, n) => (n === 1 ? err('ExpiredTokenException', 'expired') : { json: { Items: [] } }));
  let invalidated = 0;
  try {
    await client(srv.endpoint, { invalidateCredentials: () => invalidated++ }).execute('SELECT * FROM "t"', []);
    assert.equal(invalidated, 1);
    assert.equal(srv.seen.length, 2);
  } finally {
    await srv.close();
  }
});

test('a session token is sent', async () => {
  const srv = await fakeDynamo(() => ({ json: {} }));
  try {
    await new DynamoClient({ region: 'eu-west-1', endpoint: srv.endpoint, credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-secret', sessionToken: 'TOK' }) }).execute('SELECT * FROM "t"', []);
    assert.equal(srv.seen[0]!.headers['x-amz-security-token'], 'TOK');
    assert.equal(srv.seen[0]!.signatureOk, true);
  } finally {
    await srv.close();
  }
});

test('transact sends ExecuteTransaction and enforces the limit', async () => {
  const srv = await fakeDynamo(() => ({ json: { Responses: [] } }));
  try {
    await client(srv.endpoint).transact([{ text: 'INSERT INTO "t" VALUE {\'pk\': ?}', values: ['a'] }, { text: 'DELETE FROM "t" WHERE pk = \'b\'', values: [] }]);
    assert.deepEqual(srv.seen[0]!.body, { TransactStatements: [{ Statement: 'INSERT INTO "t" VALUE {\'pk\': ?}', Parameters: [{ S: 'a' }] }, { Statement: 'DELETE FROM "t" WHERE pk = \'b\'' }] });
    await assert.rejects(() => client(srv.endpoint).transact(Array.from({ length: 101 }, () => ({ text: 'x', values: [] }))), /at most 100/);
    await client(srv.endpoint).transact([]);
    assert.equal(srv.seen.length, 1);
  } finally {
    await srv.close();
  }
});

test('a request that gets no answer times out', async () => {
  const http = await import('node:http');
  const server = http.createServer(() => undefined);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    await assert.rejects(() => client(`http://127.0.0.1:${port}`, { timeoutMs: 100 }).execute('SELECT * FROM "t"', []), /did not answer/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('resolveTarget: AWS hosts, China, and endpoint rules', () => {
  assert.equal(resolveTarget('eu-west-1').host, 'dynamodb.eu-west-1.amazonaws.com');
  assert.equal(resolveTarget('cn-north-1').host, 'dynamodb.cn-north-1.amazonaws.com.cn');
  assert.equal(resolveTarget('local', 'http://localhost:8000').host, 'localhost:8000');
  assert.equal(resolveTarget('eu-west-1', 'https://vpce-1.dynamodb.eu-west-1.vpce.amazonaws.com').port, 443);
  const bad = (region: string, endpoint?: string) => assert.throws(() => resolveTarget(region, endpoint), DynamoError);
  bad('EU WEST');
  bad('x');
  bad('eu-west-1', 'http://dynamodb.example.com'); // clear text off the machine
  bad('eu-west-1', 'ftp://example.com');
  bad('eu-west-1', 'https://user:pw@example.com');
  bad('eu-west-1', 'https://example.com/path');
  bad('eu-west-1', 'https://example.com/?a=1');
  bad('eu-west-1', 'not a url');
});
