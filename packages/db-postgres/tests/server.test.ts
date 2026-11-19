import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PgConnection } from '../src/connection.js';
import { postgresDriver, PostgresError } from '../src/index.js';
import { fakeServer, TYPED, type FakeOptions, type FakeServer } from './fake-server.js';

const servers: FakeServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function server(o: FakeOptions = {}): Promise<FakeServer> {
  const s = await fakeServer(o);
  servers.push(s);
  return s;
}

const dsn = (s: FakeServer, password = 'secret', query = ''): string => `postgres://app:${encodeURIComponent(password)}@127.0.0.1:${s.port}/main${query}`;

test('SCRAM login, then a statement with a bound value', async () => {
  const s = await server();
  const db = await postgresDriver.connect('dsn', { dsn: dsn(s) });
  assert.deepEqual((await db.execute({ text: 'SELECT $1::int AS n', values: [4] })).rows, [{ n: 4 }]);
  assert.deepEqual(s.lastValues, ['4']);
  assert.deepEqual(s.startupParams, { user: 'app', database: 'main', client_encoding: 'UTF8', DateStyle: 'ISO, MDY', application_name: 'pf' });
  await db.close();
});

test('a wrong password is the server error, and does not show the password', async () => {
  const s = await server();
  await assert.rejects(postgresDriver.connect('dsn', { dsn: dsn(s, 'wrong-pw') }), (e: unknown) => {
    assert.ok(e instanceof PostgresError);
    assert.equal(e.code, '28P01');
    assert.match(e.message, /password authentication failed for user "app"/);
    assert.ok(!e.message.includes('wrong-pw'));
    return true;
  });
});

test('a server that cannot prove it knows the password is refused', async () => {
  const s = await server({ forgeSignature: true });
  await assert.rejects(postgresDriver.connect('dsn', { dsn: dsn(s) }), /server signature does not match/);
});

test('md5, cleartext and trust logins', async () => {
  for (const auth of ['md5', 'cleartext', 'trust'] as const) {
    const s = await server({ auth });
    const db = await postgresDriver.connect('params', { host: '127.0.0.1', port: s.port, user: 'app', database: 'main', password: 'secret' });
    assert.deepEqual((await db.execute({ text: 'SELECT $1::text AS v', values: [auth] })).rows, [{ v: auth }]);
    await db.close();
  }
  const s = await server({ auth: 'md5' });
  await assert.rejects(postgresDriver.connect('params', { host: '127.0.0.1', port: s.port, user: 'app', database: 'main' }), /asks for a password for "app"/);
});

test('a server error leaves the session usable', async () => {
  const s = await server();
  const db = await postgresDriver.connect('dsn', { dsn: dsn(s) });
  await assert.rejects(db.execute({ text: 'SELECT boom', values: [] }), (e: unknown) => e instanceof PostgresError && e.code === '42703');
  assert.deepEqual((await db.execute({ text: 'SELECT $1::int AS n', values: [7] })).rows, [{ n: 7 }]);
  await db.close();
});

test('values decode by type', async () => {
  const s = await server();
  const db = await postgresDriver.connect('dsn', { dsn: dsn(s) });
  const [row] = (await db.execute({ text: 'SELECT typed', values: [] })).rows;
  assert.deepEqual(Object.keys(row!), TYPED.map(([n]) => n));
  assert.equal(row!.i4, 42);
  assert.equal(row!.i8, '9007199254740993');
  assert.equal(row!.num, '1.10');
  assert.equal(row!.f8, -1.5e-7);
  assert.equal(row!.ok, true);
  assert.deepEqual(row!.doc, { a: [1, 'x'] });
  assert.deepEqual([...(row!.raw as Buffer)], [0, 255, 16]);
  assert.equal((row!.at as Date).toISOString(), '2024-01-02T02:04:05.123Z');
  assert.deepEqual(row!.ints, [1, 2, null]);
  assert.deepEqual(row!.words, ['a', 'b,c', 'NULL', null]);
  assert.equal(row!.name, 'été');
  assert.equal(row!.nothing, null);
  assert.equal(row!.span, '1 day 02:00:00');
  await db.close();
});

test('transactions: BEGIN / COMMIT around the work, ROLLBACK when it throws, savepoints inside', async () => {
  const s = await server();
  const db = await postgresDriver.connect('dsn', { dsn: dsn(s) });
  const affected = await db.transaction(async (tx) => (await tx.execute({ text: 'UPDATE t SET a = $1', values: [1] })).affected);
  assert.equal(affected, 3);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.transaction(async (inner) => inner.execute({ text: 'INSERT INTO t VALUES ($1)', values: [2] }));
      throw new Error('stop');
    }),
    /stop/,
  );
  assert.deepEqual(s.statements, [
    'BEGIN',
    'UPDATE t SET a = $1',
    'COMMIT',
    'BEGIN',
    'SAVEPOINT pf_sp_1',
    'INSERT INTO t VALUES ($1)',
    'RELEASE SAVEPOINT pf_sp_1',
    'ROLLBACK',
  ]);
  await db.close();
});

test('statements started together run one after the other', async () => {
  const s = await server();
  const conn = await PgConnection.open({ host: '127.0.0.1', port: s.port, user: 'app', password: 'secret', database: 'main', tls: 'off' });
  const results = await Promise.all([1, 2, 3].map((n) => conn.query('SELECT $1::int AS n', [n])));
  assert.deepEqual(results.map((r) => r.rows[0]), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(conn.parameters.get('server_version'), '16.0');
  await conn.close();
});

test('a FATAL error ends the connection', async () => {
  const s = await server();
  const db = await postgresDriver.connect('dsn', { dsn: dsn(s) });
  await assert.rejects(db.execute({ text: 'FATAL', values: [] }), (e: unknown) => e instanceof PostgresError && e.code === '57P01');
  await assert.rejects(db.execute({ text: 'SELECT $1::int AS n', values: [1] }), /terminating connection/);
  await db.close();
});

test('close sends Terminate; the session is unusable after it', async () => {
  const s = await server();
  const db = await postgresDriver.connect('dsn', { dsn: dsn(s) });
  await db.close();
  assert.equal(s.received.at(-1), 'X');
  await assert.rejects(db.execute({ text: 'SELECT $1::int AS n', values: [1] }), /connection is closed/);
});

test('TLS: require fails without it, prefer goes on in plain text', async () => {
  const s = await server();
  await assert.rejects(postgresDriver.connect('dsn', { dsn: dsn(s, 'secret', '?sslmode=require') }), /does not offer it/);
  const db = await postgresDriver.connect('dsn', { dsn: dsn(s, 'secret', '?sslmode=prefer') });
  assert.deepEqual((await db.execute({ text: 'SELECT $1::int AS n', values: [5] })).rows, [{ n: 5 }]);
  await db.close();
});

test('a server that never answers times out', async () => {
  const s = await server({ silent: true });
  await assert.rejects(
    PgConnection.open({ host: '127.0.0.1', port: s.port, user: 'app', database: 'main', tls: 'off', connectTimeoutMs: 200 }),
    /timed out connecting to 127\.0\.0\.1:\d+ after 0\.2 s/,
  );
});

test('nothing listening is a connection error', async () => {
  const s = await server();
  const port = s.port;
  await s.close();
  servers.splice(servers.indexOf(s), 1);
  await assert.rejects(PgConnection.open({ host: '127.0.0.1', port, user: 'app', database: 'main', tls: 'off' }), /ECONNREFUSED/);
});

const live = process.env.PF_TEST_PG_URL;
test('live: typed values against PF_TEST_PG_URL', { skip: !live && 'set PF_TEST_PG_URL to run' }, async () => {
  const s = await postgresDriver.connect('dsn', { dsn: live! });
  assert.deepEqual((await s.execute({ text: 'SELECT $1::int AS n', values: [4] })).rows, [{ n: 4 }]);
  const [row] = (
    await s.execute({
      text: "SELECT $1::bigint AS big, 1.10::numeric AS num, true AS ok, '{\"a\":1}'::jsonb AS doc, '\\x01ff'::bytea AS raw, ARRAY[1,NULL,3] AS ints, $2::timestamptz AS at",
      values: ['9007199254740993', new Date('2024-01-02T03:04:05.006Z')],
    })
  ).rows;
  assert.equal(row!.big, '9007199254740993');
  assert.equal(row!.num, '1.10');
  assert.equal(row!.ok, true);
  assert.deepEqual(row!.doc, { a: 1 });
  assert.deepEqual([...(row!.raw as Buffer)], [1, 255]);
  assert.deepEqual(row!.ints, [1, null, 3]);
  assert.equal((row!.at as Date).toISOString(), '2024-01-02T03:04:05.006Z');
  await assert.rejects(s.execute({ text: 'SELECT no_such_column', values: [] }), (e: unknown) => e instanceof PostgresError && e.code === '42703');
  assert.equal((await s.transaction(async (tx) => (await tx.execute({ text: 'SELECT 1 AS one', values: [] })).rows))[0]!.one, 1);
  await s.close();
});
