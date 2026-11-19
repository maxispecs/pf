import assert from 'node:assert/strict';
import { constants, createHash, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes, verify } from 'node:crypto';
import { test } from 'node:test';
import { ed25519PublicKey } from '../src/ed25519.js';
import { mysqlDriver } from '../src/index.js';
import { Reader, Writer } from '../src/packet.js';
import { CLIENT, MysqlError } from '../src/protocol.js';
import { FLAG_UNSIGNED, TYPE } from '../src/types.js';
import { column, eof, err, fakeServer, handshake, ok, PARAM_DEF, readLogin, resultSet, SCRAMBLE, serveCommands, SERVER_CAPS, type Peer } from './fakeserver.js';

const sha = (alg: string, ...parts: Buffer[]): Buffer => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
};
const xor = (a: Buffer, b: Buffer): Buffer => Buffer.from(a.map((x, i) => x ^ b[i % b.length]!));

const PASSWORD = 'pä55-word';

/** Check the scramble the way the server does: it only stores SHA1(SHA1(password)). */
function checkNative(auth: Buffer, scramble = SCRAMBLE): void {
  const stored = sha('sha1', sha('sha1', Buffer.from(PASSWORD)));
  const stage1 = xor(auth, sha('sha1', scramble, stored));
  assert.deepEqual(sha('sha1', stage1), stored, 'native password scramble');
}

/** caching_sha2 stores SHA256(SHA256(password)). */
function checkSha2(auth: Buffer): void {
  const stored = sha('sha256', sha('sha256', Buffer.from(PASSWORD)));
  const stage1 = xor(auth, sha('sha256', stored, SCRAMBLE));
  assert.deepEqual(sha('sha256', stage1), stored, 'caching_sha2 scramble');
}

async function nativeLogin(peer: Peer): Promise<void> {
  peer.send(handshake());
  const login = readLogin(await peer.must());
  checkNative(login.auth);
  peer.send(ok());
}

const connect = (port: number, extra: Record<string, string | number | boolean> = {}) =>
  mysqlDriver.connect('params', { host: '127.0.0.1', port, user: 'app', password: PASSWORD, database: 'billing', ...extra });

test('native login, a text result set with every common type, writes and a transaction', async () => {
  const seen: string[] = [];
  const server = await fakeServer(async (peer) => {
    peer.send(handshake());
    const login = readLogin(await peer.must());
    assert.equal(login.user, 'app');
    assert.equal(login.database, 'billing');
    assert.equal(login.plugin, 'mysql_native_password');
    assert.equal(login.caps & CLIENT.LOCAL_FILES, 0, 'never offers local files');
    assert.equal(login.caps & CLIENT.MULTI_STATEMENTS, 0, 'never multi statements');
    assert.ok(login.caps & CLIENT.FOUND_ROWS);
    checkNative(login.auth);
    peer.send(ok());
    await serveCommands(peer, (cmd) => {
      assert.equal(cmd[0], 0x03);
      const text = cmd.subarray(1).toString();
      seen.push(text);
      if (text.startsWith('SELECT')) {
        peer.send(
          ...resultSet(
            [
              { name: 'id', type: TYPE.LONG },
              { name: 'big', type: TYPE.LONGLONG },
              { name: 'small_big', type: TYPE.LONGLONG },
              { name: 'price', type: TYPE.NEWDECIMAL },
              { name: 'at', type: TYPE.DATETIME },
              { name: 'zero', type: TYPE.DATE },
              { name: 'took', type: TYPE.TIME },
              { name: 'doc', type: TYPE.JSON, charset: 63 },
              { name: 'name', type: TYPE.VAR_STRING },
              { name: 'raw', type: TYPE.BLOB, charset: 63 },
              { name: 'gone', type: TYPE.VAR_STRING },
            ],
            [['7', '9007199254740993', '12', '10.50', '2026-11-19 12:30:05.250', '0000-00-00', '-12:00:01', '{"a":[1]}', 'Zoë', Buffer.from([1, 2]), null]],
          ),
        );
      } else if (text.startsWith('UPDATE')) peer.send(ok(2, 0));
      else if (text.startsWith('INSERT')) peer.send(ok(1, 14));
      else peer.send(ok());
    });
  });
  const s = await connect(server.port);
  const { rows } = await s.execute({ text: 'SELECT everything', values: [] });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.id, 7);
  assert.equal(row.big, '9007199254740993');
  assert.equal(row.small_big, 12);
  assert.equal(row.price, '10.50');
  assert.ok(row.at instanceof Date);
  assert.deepEqual([(row.at as Date).getFullYear(), (row.at as Date).getHours(), (row.at as Date).getMilliseconds()], [2026, 12, 250]);
  assert.ok(Number.isNaN((row.zero as Date).getTime()));
  assert.equal(row.took, '-12:00:01');
  assert.deepEqual(row.doc, { a: [1] });
  assert.equal(row.name, 'Zoë');
  assert.deepEqual(row.raw, Buffer.from([1, 2]));
  assert.equal(row.gone, null);
  assert.deepEqual(await s.execute({ text: 'UPDATE t SET a = 1', values: [] }), { rows: [], affected: 2 });
  assert.deepEqual(await s.execute({ text: 'INSERT INTO t VALUES (1)', values: [] }), { rows: [], affected: 1, insertId: 14 });
  await s.transaction(async (tx) => {
    await tx.execute({ text: 'UPDATE inside', values: [] });
  });
  await s.close();
  await server.done;
  assert.deepEqual(seen.slice(3), ['BEGIN', 'UPDATE inside', 'COMMIT']);
});

/** Decode the values of a COM_STMT_EXECUTE the way a server does. */
function readExecute(payload: Buffer, count: number): { id: number; types: [number, number][]; values: unknown[] } {
  const r = new Reader(payload);
  assert.equal(r.u8(), 0x17);
  const id = r.u32();
  assert.equal(r.u8(), 0, 'no cursor');
  assert.equal(r.u32(), 1, 'one iteration');
  const bitmap = r.bytes((count + 7) >> 3);
  assert.equal(r.u8(), 1, 'types are bound');
  const types: [number, number][] = [];
  for (let i = 0; i < count; i++) types.push([r.u8(), r.u8()]);
  const values = types.map(([type, flag], i) => {
    if (bitmap[i >> 3]! & (1 << (i & 7))) return null;
    if (type === TYPE.LONGLONG) return flag & 0x80 ? r.u64() : r.i64();
    if (type === TYPE.TINY) return r.u8();
    if (type === TYPE.DOUBLE) return r.f64();
    if (type === TYPE.DATETIME) {
      const len = r.u8();
      return [len, r.u16(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u32()];
    }
    return Buffer.from(r.lenencBytes()!);
  });
  return { id, types, values };
}

test('values go as a prepared statement and come back through the binary protocol', async () => {
  let closed = -1;
  const date = new Date(2026, 10, 19, 8, 9, 10, 123);
  const server = await fakeServer(async (peer) => {
    await nativeLogin(peer);
    await serveCommands(peer, async (cmd) => {
      if (cmd[0] === 0x19) {
        closed = new Reader(cmd.subarray(1)).u32();
        return;
      }
      assert.equal(cmd[0], 0x16, 'COM_STMT_PREPARE');
      assert.equal(cmd.subarray(1).toString(), 'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?');
      peer.send(new Writer().u8(0).u32(5).u16(3).u16(9).u8(0).u16(0).toBuffer());
      peer.send(...Array.from({ length: 9 }, () => PARAM_DEF), eof());
      const cols = [
        { name: 'n', type: TYPE.LONGLONG },
        { name: 'u', type: TYPE.LONGLONG, flags: FLAG_UNSIGNED },
        { name: 'f', type: TYPE.FLOAT },
      ];
      peer.send(...cols.map(column), eof());
      const exec = readExecute(await peer.must(true), 9);
      assert.equal(exec.id, 5);
      assert.deepEqual(
        exec.types.map(([t]) => t),
        [TYPE.LONGLONG, TYPE.VAR_STRING, TYPE.NULL, TYPE.TINY, TYPE.DOUBLE, TYPE.BLOB, TYPE.DATETIME, TYPE.LONGLONG, TYPE.VAR_STRING],
      );
      assert.equal(exec.types[7]![1], 0x80, 'unsigned flag');
      assert.deepEqual(exec.values, [
        5n,
        Buffer.from("it's \\ 'quoted'"),
        null,
        1,
        2.5,
        Buffer.from([9, 8]),
        [11, 2026, 11, 19, 8, 9, 10, 123000],
        2n ** 63n,
        Buffer.from('{"k":1}'),
      ]);
      const row = new Writer().u8(0).u8(0).i64(-3n).u64(2n ** 64n - 1n);
      const f32 = Buffer.alloc(4);
      f32.writeFloatLE(1.1);
      peer.send(new Writer().lenenc(3).toBuffer(), ...cols.map(column), eof(), row.bytes(f32).toBuffer(), eof());
    });
  });
  const s = await connect(server.port);
  const { rows } = await s.execute({
    text: 'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?',
    values: [5, "it's \\ 'quoted'", null, true, 2.5, Buffer.from([9, 8]), date, 2n ** 63n, { k: 1 }],
  });
  assert.deepEqual(rows, [{ n: -3, u: '18446744073709551615', f: 1.1 }]);
  await s.close();
  await server.done;
  assert.equal(closed, 5, 'the statement is closed');
});

test('a placeholder count mismatch fails before executing and leaves the connection usable', async () => {
  const commands: number[] = [];
  const server = await fakeServer(async (peer) => {
    await nativeLogin(peer);
    await serveCommands(peer, (cmd) => {
      commands.push(cmd[0]!);
      if (cmd[0] === 0x16) peer.send(new Writer().u8(0).u32(1).u16(0).u16(2).u8(0).u16(0).toBuffer(), PARAM_DEF, PARAM_DEF, eof());
      else if (cmd[0] === 0x03) peer.send(err(1146, '42S02', "Table 'billing.nope' doesn't exist"));
    });
  });
  const s = await connect(server.port);
  await assert.rejects(s.execute({ text: 'SELECT ?, ?', values: [1] }), /2 placeholders but 1 value was given/);
  await assert.rejects(s.execute({ text: 'SELECT * FROM nope', values: [] }), (e: unknown) => {
    assert.ok(e instanceof MysqlError);
    assert.equal(e.code, 'ER_NO_SUCH_TABLE');
    assert.equal(e.errno, 1146);
    assert.equal(e.sqlState, '42S02');
    return true;
  });
  await s.close();
  await server.done;
  assert.deepEqual(commands, [0x16, 0x19, 0x03]);
});

test('a login error is a MysqlError with its code', async () => {
  const server = await fakeServer(async (peer) => {
    peer.send(handshake());
    await peer.must();
    peer.send(err(1045, '28000', "Access denied for user 'app'@'localhost'"));
  });
  await assert.rejects(connect(server.port), (e: unknown) => e instanceof MysqlError && e.code === 'ER_ACCESS_DENIED_ERROR');
  await server.done;
});

test('caching_sha2_password: the fast path', async () => {
  const server = await fakeServer(async (peer) => {
    peer.send(handshake('caching_sha2_password'));
    const login = readLogin(await peer.must());
    assert.equal(login.plugin, 'caching_sha2_password');
    checkSha2(login.auth);
    peer.send(Buffer.from([0x01, 0x03]), ok());
    await serveCommands(peer, () => undefined);
  });
  await (await connect(server.port)).close();
  await server.done;
});

test('caching_sha2_password: full authentication with the server RSA key', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const server = await fakeServer(async (peer) => {
    peer.send(handshake('caching_sha2_password'));
    checkSha2(readLogin(await peer.must()).auth);
    peer.send(Buffer.from([0x01, 0x04]));
    assert.deepEqual(await peer.must(), Buffer.from([0x02]), 'asks for the public key');
    peer.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }) as string)]));
    const encrypted = await peer.must();
    const plain = xor(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, encrypted), SCRAMBLE);
    assert.equal(plain.toString(), `${PASSWORD}\0`);
    peer.send(ok());
    await serveCommands(peer, () => undefined);
  });
  await (await connect(server.port)).close();
  await server.done;
});

test('MariaDB client_ed25519 through an auth switch', async () => {
  const nonce = randomBytes(32);
  const server = await fakeServer(async (peer) => {
    peer.send(handshake());
    await peer.must();
    peer.send(Buffer.concat([Buffer.from([0xfe]), Buffer.from('client_ed25519\0'), nonce]));
    const signature = await peer.must();
    assert.equal(signature.length, 64);
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), ed25519PublicKey(Buffer.from(PASSWORD))]);
    assert.ok(verify(null, nonce, createPublicKey({ key: der, format: 'der', type: 'spki' }), signature), 'the signature verifies');
    peer.send(ok());
    await serveCommands(peer, () => undefined);
  });
  await (await connect(server.port)).close();
  await server.done;
});

test('an auth plugin pf does not know is refused by name', async () => {
  const server = await fakeServer(async (peer) => {
    peer.send(handshake());
    await peer.must();
    peer.send(Buffer.concat([Buffer.from([0xfe]), Buffer.from('mysql_clear_password\0')]));
    await peer.next();
  });
  await assert.rejects(connect(server.port), /"mysql_clear_password" authentication plugin/);
  await server.done;
});

test('LOAD DATA LOCAL INFILE is refused without reading a file', async () => {
  const server = await fakeServer(async (peer) => {
    await nativeLogin(peer);
    await serveCommands(peer, async (cmd) => {
      if (cmd.subarray(1).toString().startsWith('LOAD')) {
        peer.send(Buffer.concat([Buffer.from([0xfb]), Buffer.from('/etc/passwd')]));
        assert.equal((await peer.must()).length, 0, 'an empty reply: no file content');
        peer.send(ok());
      } else peer.send(...resultSet([{ name: 'n', type: TYPE.LONG }], [['1']]));
    });
  });
  const s = await connect(server.port);
  await assert.rejects(s.execute({ text: "LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t", values: [] }), /pf never sends files/);
  assert.deepEqual((await s.execute({ text: 'SELECT 1 AS n', values: [] })).rows, [{ n: 1 }]);
  await s.close();
  await server.done;
});

test('TLS is refused when the server does not offer it', async () => {
  const server = await fakeServer(async (peer) => {
    peer.send(handshake('mysql_native_password', SERVER_CAPS & ~CLIENT.SSL));
    await peer.next();
  });
  await assert.rejects(connect(server.port, { ssl: true }), /does not offer it/);
  await server.done;
});

test('a server that hangs up fails the query and the connection', async () => {
  const server = await fakeServer(async (peer) => {
    await nativeLogin(peer);
    await peer.must(true);
    peer.socket.destroy();
  });
  const s = await connect(server.port);
  await assert.rejects(s.execute({ text: 'SELECT 1', values: [] }), /closed the connection/);
  await assert.rejects(s.execute({ text: 'SELECT 1', values: [] }), /closed the connection/);
  await s.close();
  await server.done;
});
