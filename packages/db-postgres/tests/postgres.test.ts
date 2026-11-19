import assert from 'node:assert/strict';
import { test } from 'node:test';
import { md5Password, ScramClient } from '../src/auth.js';
import { connectionConfig, parseDsn } from '../src/config.js';
import { postgresDriver, toResult } from '../src/index.js';
import { bind, MessageReader, parseCommandComplete, parseErrorFields, PostgresError, startup } from '../src/protocol.js';
import { arrayLiteral, dateToString, decodeValue, encodeParam, OID, parseArray, parseBytea, parseDate } from '../src/types.js';

test('the params form: TLS only when asked, the password only when given, a / host is a socket', () => {
  assert.deepEqual(connectionConfig('params', { host: 'db', port: 6543, user: 'app', database: 'main', password: 'pw', ssl: true }), {
    host: 'db', port: 6543, user: 'app', password: 'pw', database: 'main', tls: 'require',
  });
  assert.deepEqual(connectionConfig('params', { host: 'db', user: 'app', database: 'main' }), { host: 'db', port: 5432, user: 'app', database: 'main', tls: 'off' });
  assert.equal(connectionConfig('params', { host: '/var/run/postgresql/', user: 'app', database: 'main' }).socketPath, '/var/run/postgresql/.s.PGSQL.5432');
  assert.throws(() => connectionConfig('params', { host: 'db' }), /required/);
  assert.throws(() => connectionConfig('params', { host: 'db', user: 'app', database: 'main', port: 70000 }), /invalid port/);
});

test('the dsn form: user, password and database decoded, sslmode mapped', () => {
  assert.deepEqual(parseDsn('postgresql://app:p%40ss%2Fw@[::1]:6543/my%20db?sslmode=verify-full&application_name=report&connect_timeout=3'), {
    host: '::1', port: 6543, user: 'app', password: 'p@ss/w', database: 'my db', tls: 'require', applicationName: 'report', connectTimeoutMs: 3000,
  });
  assert.deepEqual(parseDsn('postgres://app@db'), { host: 'db', port: 5432, user: 'app', database: 'app', tls: 'off' });
  assert.equal(parseDsn('postgres://app@db/x?sslmode=prefer').tls, 'prefer');
  assert.equal(parseDsn('postgres://app@db/x?sslmode=disable').tls, 'off');
  assert.equal(parseDsn('postgres://app@db/x?ssl=true').tls, 'require');
  assert.throws(() => connectionConfig('dsn', { dsn: '' }), /empty/);
});

test('the dsn form: Unix sockets from ?host= or an encoded host, even with a password and no host', () => {
  const a = parseDsn('postgres://app:pw@/main?host=/tmp');
  assert.equal(a.socketPath, '/tmp/.s.PGSQL.5432');
  assert.equal(a.password, 'pw');
  assert.equal(parseDsn('postgres://app@%2Fvar%2Frun%2Fpostgresql:5433/main').socketPath, '/var/run/postgresql/.s.PGSQL.5433');
  assert.equal(parseDsn('postgres://app@/main?host=/tmp&port=6000').socketPath, '/tmp/.s.PGSQL.6000');
  assert.throws(() => parseDsn('postgres:///main?host=/tmp'), /no user/);
});

test('dsn errors are clear and never show the password', () => {
  const cases: [string, RegExp][] = [
    ['mysql://u:s3cret@h/d', /must start with postgres/],
    ['host=h user=u password=s3cret', /not key=value/],
    ['postgres://u:s3cret@h/d?sslmode=sometimes', /sslmode .* must be one of/],
    ['postgres://u:s3cret@h/d?sslrootcert=/ca.pem', /unsupported parameter "sslrootcert"/],
    ['postgres://u:s3cret@h:99999/d', /not a valid URL|invalid port/],
    ['postgres://:s3cret@h/d', /no user/],
    ['postgres://u:s3%ZZcret@h/d', /malformed password/],
  ];
  for (const [dsn, re] of cases) {
    assert.throws(() => parseDsn(dsn), (e: Error) => re.test(e.message) && !e.message.includes('s3') && !e.message.includes(dsn));
  }
});

test('results: rows for reads, affected counts for writes', () => {
  assert.deepEqual(toResult({ rows: [{ a: 1 }], rowCount: 1, command: 'SELECT' }), { rows: [{ a: 1 }] });
  assert.deepEqual(toResult({ rows: [], rowCount: 3, command: 'UPDATE' }), { rows: [], affected: 3 });
  assert.deepEqual(toResult({ rows: [{ id: 5 }], rowCount: 1, command: 'INSERT' }), { rows: [{ id: 5 }], affected: 1 });
  assert.deepEqual(toResult({ rows: [], rowCount: null, command: 'BEGIN' }), { rows: [] });
});

test('the forms ask for a secret password and a secret dsn, and describe shows no secret', () => {
  const secrets = postgresDriver.forms.flatMap((f) => f.fields).filter((f) => f.kind === 'secret').map((f) => f.key);
  assert.deepEqual(secrets, ['password', 'dsn']);
  assert.equal(postgresDriver.describe('params', { host: 'db', port: 5432, user: 'app', database: 'main' }), 'app@db:5432/main');
  assert.equal(postgresDriver.describe('dsn', {}), 'connection string');
});

test('protocol: the startup message and bind encode as the spec says', () => {
  const s = startup({ user: 'u', database: 'd' });
  assert.equal(s.readInt32BE(0), s.length);
  assert.equal(s.readInt32BE(4), 196608);
  assert.equal(s.subarray(8).toString('latin1'), 'user\0u\0database\0d\0\0');
  const b = bind([Buffer.from('7'), null]);
  assert.equal(b.toString('latin1', 0, 1), 'B');
  // portal "", statement "", 0 parameter formats (all text), 2 values: "7" and NULL, 0 result formats (all text)
  assert.deepEqual([...b.subarray(5)], [0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0x37, 0xff, 0xff, 0xff, 0xff, 0, 0]);
  assert.throws(() => bind(new Array(70000).fill(null)), /at most 65535/);
});

test('protocol: messages are framed across any chunking', () => {
  const two = Buffer.concat([Buffer.from([0x5a, 0, 0, 0, 5, 0x49]), Buffer.from([0x43, 0, 0, 0, 13]), Buffer.from('SELECT 1\0')]);
  const whole = new MessageReader().push(two);
  assert.deepEqual(whole.map((m) => [m.type, m.body.toString('latin1')]), [['Z', 'I'], ['C', 'SELECT 1\0']]);
  const r = new MessageReader();
  const bytewise = [...two].flatMap((byte) => r.push(Buffer.from([byte])));
  assert.deepEqual(bytewise.map((m) => m.type), ['Z', 'C']);
  assert.throws(() => new MessageReader().push(Buffer.from([0x5a, 0, 0, 0, 2])), /invalid length/);
});

test('protocol: command tags and error fields', () => {
  const tag = (s: string) => parseCommandComplete(Buffer.from(`${s}\0`));
  assert.deepEqual(tag('INSERT 0 3'), { command: 'INSERT', rowCount: 3 });
  assert.deepEqual(tag('UPDATE 2'), { command: 'UPDATE', rowCount: 2 });
  assert.deepEqual(tag('BEGIN'), { command: 'BEGIN', rowCount: null });
  assert.deepEqual(tag('CREATE TABLE'), { command: 'CREATE', rowCount: null });
  const e = new PostgresError(parseErrorFields(Buffer.from('SERREUR\0VERROR\0C23505\0Mduplicate key\0Dkey (id)=(1)\0nusers_pkey\0\0')));
  assert.equal(e.message, 'duplicate key');
  assert.equal(e.severity, 'ERROR');
  assert.equal(e.code, '23505');
  assert.equal(e.detail, 'key (id)=(1)');
  assert.equal(e.constraint, 'users_pkey');
  assert.equal(e.fatal, false);
  assert.ok(!('hint' in e));
});

test('auth: md5 matches the known value', () => {
  assert.equal(md5Password('postgres', 'secret', Buffer.from([1, 2, 3, 4])), 'md5bb41a296aab6baccb36ff243a562abff');
});

test('auth: SCRAM-SHA-256 follows the RFC 7677 example', () => {
  const c = new ScramClient('pencil', 'rOprNGfwEbeRWgbNEkqO', 'user');
  assert.equal(c.first().toString(), 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO');
  const serverFirst = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
  assert.equal(c.final(serverFirst).toString(), 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
  assert.equal(c.verified, false);
  c.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  assert.equal(c.verified, true);
});

test('auth: SCRAM refuses a forged signature, a foreign nonce and a server error', () => {
  const serverFirst = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
  const c = new ScramClient('pencil', 'rOprNGfwEbeRWgbNEkqO', 'user');
  c.final(serverFirst);
  assert.throws(() => c.verify('v=AAAAZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ='), /signature does not match/);
  assert.throws(() => c.verify('e=invalid-proof'), /refused the login/);
  assert.throws(() => new ScramClient('pencil', 'abc').final('r=xyz,s=c2FsdA==,i=4096'), /invalid nonce/);
  assert.throws(() => new ScramClient('pencil', 'abc').final('r=abcdef,s=c2FsdA==,i=0'), /iteration count/);
  assert.throws(() => new ScramClient('pencil', 'abc').verify('v=AAAA'), /finished before/);
});

test('types: scalars decode like node-postgres', () => {
  assert.equal(decodeValue(OID.BOOL, 't'), true);
  assert.equal(decodeValue(OID.BOOL, 'f'), false);
  assert.equal(decodeValue(OID.INT4, '-12'), -12);
  assert.equal(decodeValue(OID.FLOAT8, 'NaN'), Number.NaN);
  assert.equal(decodeValue(OID.FLOAT8, '-Infinity'), Number.NEGATIVE_INFINITY);
  assert.equal(decodeValue(OID.INT8, '9007199254740993'), '9007199254740993');
  assert.equal(decodeValue(OID.NUMERIC, '1.10'), '1.10');
  assert.deepEqual(decodeValue(OID.JSONB, '{"a": [1, null]}'), { a: [1, null] });
  assert.equal(decodeValue(OID.JSON, '"x"'), 'x');
  assert.equal(decodeValue(1186, '1 day'), '1 day');
  assert.equal(decodeValue(2950, '6f1c...'), '6f1c...');
  assert.equal(decodeValue(OID.INT4, null), null);
});

test('types: bytea in hex and escape output', () => {
  assert.deepEqual([...parseBytea('\\x00ff10')], [0, 255, 16]);
  assert.deepEqual([...parseBytea('a\\000\\\\b\\377')], [0x61, 0, 0x5c, 0x62, 255]);
  assert.ok(Buffer.isBuffer(decodeValue(OID.BYTEA, '\\x')));
});

test('types: dates, timestamps and timestamptz', () => {
  const local = parseDate('2024-01-02 03:04:05.123456') as Date;
  assert.deepEqual([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds()], [2024, 0, 2, 3, 4, 5, 123]);
  const day = parseDate('0099-12-31') as Date;
  assert.deepEqual([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()], [99, 11, 31, 0]);
  assert.equal((parseDate('2024-01-02 03:04:05.5+01') as Date).toISOString(), '2024-01-02T02:04:05.500Z');
  assert.equal((parseDate('2024-01-02 03:04:05-05:30') as Date).toISOString(), '2024-01-02T08:34:05.000Z');
  assert.equal((parseDate('1900-01-01 00:00:00+00:19:32') as Date).toISOString(), '1899-12-31T23:40:28.000Z');
  assert.equal((parseDate('0044-03-15 12:00:00+00 BC') as Date).getUTCFullYear(), -43);
  assert.equal(parseDate('infinity'), Number.POSITIVE_INFINITY);
  assert.equal(parseDate('-infinity'), Number.NEGATIVE_INFINITY);
  assert.equal(parseDate('not a date'), 'not a date');
});

test('types: array literals', () => {
  assert.deepEqual(parseArray('{}', Number), []);
  assert.deepEqual(parseArray('{1,2,NULL}', Number), [1, 2, null]);
  assert.deepEqual(parseArray('{{1,2},{3,4}}', Number), [[1, 2], [3, 4]]);
  assert.deepEqual(parseArray('{a,"b,c","NULL","q\\"x\\\\y",""}', (s) => s), ['a', 'b,c', 'NULL', 'q"x\\y', '']);
  assert.deepEqual(parseArray('[0:1]={7,8}', Number), [7, 8]);
  assert.throws(() => parseArray('{"open', (s) => s), /malformed array/);
  assert.deepEqual(decodeValue(1016, '{1,9007199254740993}'), ['1', '9007199254740993']);
  assert.deepEqual(decodeValue(1000, '{t,f}'), [true, false]);
  assert.deepEqual(decodeValue(3807, '{"{\\"a\\":1}"}'), [{ a: 1 }]);
});

test('types: parameters encode like node-postgres', () => {
  const text = (v: unknown) => encodeParam(v)?.toString('utf8') ?? null;
  assert.equal(text(null), null);
  assert.equal(text(undefined), null);
  assert.equal(text('é'), 'é');
  assert.equal(text(4.5), '4.5');
  assert.equal(text(12345678901234567890n), '12345678901234567890');
  assert.equal(text(true), 'true');
  assert.equal(text({ a: [1] }), '{"a":[1]}');
  assert.equal(text(new Uint8Array([0, 255])), '\\x00ff');
  assert.equal(text(Buffer.from('hi')), '\\x6869');
  assert.equal(text([1, null, 'a"b\\c', ['x']]), '{"1",NULL,"a\\"b\\\\c",{"x"}}');
  assert.equal(arrayLiteral([]), '{}');
  assert.throws(() => encodeParam(Symbol('x')), /cannot bind a symbol/);
  assert.throws(() => encodeParam(new Date(Number.NaN)), /Invalid Date/);
});

test('types: a Date goes out with its offset and comes back as the same instant', () => {
  for (const d of [new Date('2024-06-30T23:59:59.999Z'), new Date('1970-01-01T00:00:00.000Z'), new Date(-62198755200000)]) {
    const s = dateToString(d);
    assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}(:\d{2})?( BC)?$/);
    assert.equal((parseDate(s) as Date).getTime(), d.getTime());
  }
});
