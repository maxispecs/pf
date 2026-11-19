import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionOptions, mysqlDriver, parseDsn } from '../src/index.js';

test('the params form maps to connection options', () => {
  assert.deepEqual(connectionOptions('params', { host: 'db', port: 3307, user: 'app', database: 'billing', password: 'pw', ssl: true }), {
    host: 'db',
    port: 3307,
    user: 'app',
    database: 'billing',
    password: 'pw',
    tls: true,
  });
  const plain = connectionOptions('params', { host: 'db', user: 'app', database: 'billing' });
  assert.equal(plain.port, 3306);
  assert.equal(plain.tls, false);
  assert.ok(!('password' in plain));
  assert.throws(() => connectionOptions('params', { host: 'db' }), /required/);
});

test('the dsn form: user, password, host, port, database and TLS', () => {
  assert.deepEqual(connectionOptions('dsn', { dsn: 'mysql://u:p@h:3306/d' }), { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd', tls: false });
  assert.deepEqual(parseDsn('mariadb://r%40x:p%3A%2F%40ss@[::1]/my%20db?ssl=true'), {
    host: '::1',
    port: 3306,
    user: 'r@x',
    password: 'p:/@ss',
    database: 'my db',
    tls: true,
  });
  const bare = parseDsn('mysql://app@db.internal');
  assert.ok(!('password' in bare) && !('database' in bare));
  assert.equal(parseDsn('mysql://a@h?ssl-mode=verify_identity').tls, true);
  assert.equal(parseDsn('mysql://a@h?sslmode=DISABLED').tls, false);
  assert.throws(() => connectionOptions('dsn', {}), /empty/);
});

test('the dsn form refuses what it would otherwise drop, and never echoes the string', () => {
  const secret = 'mysql://u:hunter2@h/d';
  for (const [dsn, why] of [
    [`${secret}?charset=latin1`, /unsupported parameter "charset"/],
    [`${secret}?ssl=yes`, /true or false/],
    [`${secret}?ssl-mode=PREFERRED`, /ssl-mode .* one of/],
    ['postgres://u:hunter2@h/d', /mysql:\/\/ or mariadb:\/\//],
    ['not a url hunter2', /not a valid URL/],
    ['mysql://h/d', /no user/],
  ] as const) {
    assert.throws(() => parseDsn(dsn), (e: Error) => why.test(e.message) && !e.message.includes('hunter2'));
  }
});

test('describe shows no secret', () => {
  assert.equal(mysqlDriver.describe('params', { host: 'db', user: 'app', database: 'billing' }), 'app@db:3306/billing');
  assert.equal(mysqlDriver.describe('dsn', {}), 'connection string');
});

const live = process.env.PF_TEST_MYSQL_URL;
test('live: types, writes and a rollback against PF_TEST_MYSQL_URL', { skip: !live && 'set PF_TEST_MYSQL_URL to run' }, async () => {
  const s = await mysqlDriver.connect('dsn', { dsn: live! });
  try {
    assert.deepEqual((await s.execute({ text: 'SELECT ? AS n', values: [4] })).rows, [{ n: 4 }]);
    const [row] = (
      await s.execute({
        text: "SELECT CAST(? AS DECIMAL(10,2)) AS d, 18446744073709551615 AS big, CAST('2026-11-19 10:11:12' AS DATETIME) AS at, JSON_OBJECT('a', 1) AS j, ? AS s, ? AS z",
        values: ['10.5', 'Zoë', null],
      })
    ).rows;
    assert.equal(row!.d, '10.50');
    assert.equal(row!.big, '18446744073709551615');
    assert.equal((row!.at as Date).getHours(), 10);
    assert.deepEqual(typeof row!.j === 'string' ? JSON.parse(row!.j) : row!.j, { a: 1 });
    assert.equal(row!.s, 'Zoë');
    assert.equal(row!.z, null);
    await s.execute({ text: 'CREATE TEMPORARY TABLE pf_t (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20))', values: [] });
    const ins = await s.execute({ text: 'INSERT INTO pf_t (v) VALUES (?), (?)', values: ['a', 'b'] });
    assert.equal(ins.affected, 2);
    assert.equal(ins.insertId, 1);
    await assert.rejects(
      s.transaction(async (tx) => {
        await tx.execute({ text: 'DELETE FROM pf_t WHERE v = ?', values: ['a'] });
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal((await s.execute({ text: 'SELECT COUNT(*) AS n FROM pf_t', values: [] })).rows[0]!.n, 2);
  } finally {
    await s.close();
  }
});
