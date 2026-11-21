/**
 * A tiny PostgreSQL server for tests: startup (refusing TLS), trust / cleartext / md5 / SCRAM-SHA-256
 * login, and canned answers to the extended query protocol. Its SCRAM and MD5 sides are written from the
 * RFCs here, not with the client's code, so the two check each other.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import net from 'node:net';
import { MessageReader, Reader, type Message } from '../src/protocol.js';

export type FakeAuth = 'trust' | 'cleartext' | 'md5' | 'scram';

export interface FakeOptions {
  auth?: FakeAuth;
  password?: string;
  /** Send a wrong SCRAM server signature. */
  forgeSignature?: boolean;
  /** Accept connections and never answer. */
  silent?: boolean;
}

export interface FakeServer {
  port: number;
  /** Every statement text the server parsed, in order. */
  statements: string[];
  /** The values bound to the last statement. */
  lastValues: (string | null)[];
  startupParams: Record<string, string>;
  /** Message types received, `X` for Terminate. */
  received: string[];
  /** The row limit of each Execute message, in order (0 = no limit). */
  executes: number[];
  close(): Promise<void>;
}

const i32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};
const i16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v);
  return b;
};
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const msg = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type, 'latin1'), i32(body.length + 4), body]);
};
const auth = (code: number, data: Buffer = Buffer.alloc(0)): Buffer => msg('R', i32(code), data);
const error = (code: string, message: string, severity = 'ERROR'): Buffer =>
  msg('E', Buffer.from('S'), cstr(severity), Buffer.from('V'), cstr(severity), Buffer.from('C'), cstr(code), Buffer.from('M'), cstr(message), Buffer.from([0]));
const ready = (status: string): Buffer => msg('Z', Buffer.from(status, 'latin1'));
const complete = (tag: string): Buffer => msg('C', cstr(tag));
const rowDescription = (cols: [string, number][]): Buffer =>
  msg('T', i16(cols.length), ...cols.flatMap(([name, oid]) => [cstr(name), i32(0), i16(0), i32(oid), i16(-1), i32(-1), i16(0)]));
const dataRow = (values: (string | null)[]): Buffer =>
  msg('D', i16(values.length), ...values.flatMap((v) => (v === null ? [i32(-1)] : [i32(Buffer.byteLength(v)), Buffer.from(v, 'utf8')])));

const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
const md5 = (b: Buffer | string): string => createHash('md5').update(b).digest('hex');

/** The typed row `SELECT typed` answers with: column, type oid, text. */
export const TYPED: [string, number, string | null][] = [
  ['i4', 23, '42'],
  ['i8', 20, '9007199254740993'],
  ['num', 1700, '1.10'],
  ['f8', 701, '-1.5e-7'],
  ['ok', 16, 't'],
  ['doc', 3802, '{"a": [1, "x"]}'],
  ['raw', 17, '\\x00ff10'],
  ['at', 1184, '2024-01-02 03:04:05.123+01'],
  ['ints', 1007, '{1,2,NULL}'],
  ['words', 1009, '{a,"b,c","NULL",NULL}'],
  ['name', 25, 'été'],
  ['nothing', 25, null],
  ['span', 1186, '1 day 02:00:00'],
];

export async function fakeServer(o: FakeOptions = {}): Promise<FakeServer> {
  const password = o.password ?? 'secret';
  const state: FakeServer = { port: 0, statements: [], lastValues: [], startupParams: {}, received: [], executes: [], close: async () => undefined };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    if (o.silent) return;
    let pending = Buffer.alloc(0);
    let started = false;
    const reader = new MessageReader();
    let user = '';
    let tx = 'I';
    let scram: { bare: string; serverFirst: string; salted: Buffer } | null = null;
    let batchFailed = false;
    let text = '';
    // `SELECT series N` answers N rows (`n` = 1..N) through a portal, `SELECT series N fail` errors on the second Execute.
    let streaming: { total: number; sent: number; fail: boolean; ignoring: boolean } | null = null;

    const loggedIn = (): void => {
      socket.write(
        Buffer.concat([
          auth(0),
          msg('S', cstr('server_version'), cstr('16.0')),
          msg('S', cstr('TimeZone'), cstr('UTC')),
          msg('K', i32(1234), i32(5678)),
          ready('I'),
        ]),
      );
    };
    const refuse = (): void => {
      socket.end(error('28P01', `password authentication failed for user "${user}"`, 'FATAL'));
    };

    const onStartup = (body: Buffer): void => {
      const r = new Reader(body);
      r.i32();
      for (let k = r.cstring(); k !== ''; k = r.cstring()) state.startupParams[k] = r.cstring();
      user = state.startupParams.user ?? '';
      const method = o.auth ?? 'scram';
      if (method === 'trust') loggedIn();
      else if (method === 'cleartext') socket.write(auth(3));
      else if (method === 'md5') socket.write(auth(5, Buffer.from([1, 2, 3, 4])));
      else socket.write(auth(10, Buffer.concat([cstr('SCRAM-SHA-256'), Buffer.from([0])])));
    };

    const onPassword = (body: Buffer): void => {
      const method = o.auth ?? 'scram';
      if (method === 'cleartext') return new Reader(body).cstring() === password ? loggedIn() : refuse();
      if (method === 'md5') {
        const expected = `md5${md5(Buffer.concat([Buffer.from(md5(password + user)), Buffer.from([1, 2, 3, 4])]))}`;
        return new Reader(body).cstring() === expected ? loggedIn() : refuse();
      }
      if (!scram) {
        const r = new Reader(body);
        r.cstring();
        const first = r.bytes(r.i32()).toString('utf8');
        const bare = first.slice(first.indexOf(',', first.indexOf(',') + 1) + 1);
        const clientNonce = /r=([^,]+)/.exec(bare)![1]!;
        const salt = randomBytes(16);
        const serverFirst = `r=${clientNonce}${randomBytes(9).toString('base64')},s=${salt.toString('base64')},i=4096`;
        scram = { bare, serverFirst, salted: pbkdf2Sync(password, salt, 4096, 32, 'sha256') };
        socket.write(auth(11, Buffer.from(serverFirst)));
        return;
      }
      const final = body.toString('utf8');
      const at = final.lastIndexOf(',p=');
      const withoutProof = final.slice(0, at);
      const proof = Buffer.from(final.slice(at + 3), 'base64');
      const authMessage = `${scram.bare},${scram.serverFirst},${withoutProof}`;
      const storedKey = sha256(hmac(scram.salted, 'Client Key'));
      const signature = hmac(storedKey, authMessage);
      const clientKey = Buffer.from(proof.map((b, i) => b ^ signature[i]!));
      if (!sha256(clientKey).equals(storedKey)) return refuse();
      const serverSignature = o.forgeSignature ? randomBytes(32) : hmac(hmac(scram.salted, 'Server Key'), authMessage);
      socket.write(auth(12, Buffer.from(`v=${serverSignature.toString('base64')}`)));
      loggedIn();
    };

    const answer = (): Buffer => {
      state.statements.push(text);
      const word = text.split(' ')[0]!.toUpperCase();
      if (text === 'SELECT boom') return Buffer.concat([error('42703', 'column "boom" does not exist'), ready(tx === 'I' ? 'I' : 'E')]);
      if (text === 'SELECT $1::int AS n') {
        return Buffer.concat([msg('1'), msg('2'), rowDescription([['n', 23]]), dataRow([state.lastValues[0] ?? null]), complete('SELECT 1'), ready(tx)]);
      }
      if (text === 'SELECT $1::text AS v') {
        return Buffer.concat([msg('1'), msg('2'), rowDescription([['v', 25]]), dataRow([state.lastValues[0] ?? null]), complete('SELECT 1'), ready(tx)]);
      }
      if (text === 'SELECT typed') {
        return Buffer.concat([
          msg('1'),
          msg('2'),
          rowDescription(TYPED.map(([n, oid]) => [n, oid])),
          dataRow(TYPED.map(([, , v]) => v)),
          complete('SELECT 1'),
          ready(tx),
        ]);
      }
      if (word === 'BEGIN') tx = 'T';
      if (word === 'COMMIT' || (word === 'ROLLBACK' && !text.includes(' TO '))) tx = 'I';
      const tag = word === 'UPDATE' ? 'UPDATE 3' : word === 'INSERT' ? 'INSERT 0 1' : word === 'ROLLBACK' || word === 'COMMIT' || word === 'BEGIN' ? word : word === 'SAVEPOINT' || word === 'RELEASE' ? word : 'SELECT 0';
      return Buffer.concat([msg('1'), msg('2'), msg('n'), complete(tag), ready(tx)]);
    };

    const onMessage = (m: Message): void => {
      state.received.push(m.type);
      if (m.type === 'p') return onPassword(m.body);
      if (m.type === 'X') {
        socket.end();
        return;
      }
      if (m.type === 'P') {
        const r = new Reader(m.body);
        r.cstring();
        text = r.cstring();
        const series = /^SELECT series (\d+)( fail)?$/.exec(text);
        streaming = series ? { total: Number(series[1]), sent: 0, fail: series[2] !== undefined, ignoring: false } : null;
        if (streaming) state.statements.push(text);
        if (text === 'FATAL') {
          socket.end(error('57P01', 'terminating connection due to administrator command', 'FATAL'));
          batchFailed = true;
        }
        return;
      }
      if (m.type === 'B') {
        const r = new Reader(m.body);
        r.cstring();
        r.cstring();
        const formats = r.i16();
        for (let i = 0; i < formats; i++) r.i16();
        const n = r.i16();
        state.lastValues = [];
        for (let i = 0; i < n; i++) {
          const len = r.i32();
          state.lastValues.push(len === -1 ? null : r.bytes(len).toString('utf8'));
        }
        return;
      }
      if (streaming && m.type === 'D') {
        socket.write(Buffer.concat([msg('1'), msg('2'), rowDescription([['n', 23]])]));
        return;
      }
      if (streaming && m.type === 'E') {
        const r = new Reader(m.body);
        r.cstring();
        const max = r.i32();
        state.executes.push(max);
        if (streaming.ignoring) return;
        if (streaming.fail && streaming.sent > 0) {
          streaming.ignoring = true;
          socket.write(error('57014', 'canceling statement due to statement timeout'));
          return;
        }
        const count = max === 0 ? streaming.total - streaming.sent : Math.min(max, streaming.total - streaming.sent);
        const out: Buffer[] = [];
        for (let i = 1; i <= count; i++) out.push(dataRow([String(streaming.sent + i)]));
        streaming.sent += count;
        // Like the real server: a full batch is PortalSuspended even when nothing is left, the next Execute then completes.
        out.push(max !== 0 && count === max ? msg('s') : complete(`SELECT ${streaming.sent}`));
        socket.write(Buffer.concat(out));
        return;
      }
      if (streaming && m.type === 'S') {
        streaming = null;
        socket.write(ready(tx));
        return;
      }
      if (m.type === 'S') {
        if (!batchFailed) socket.write(answer());
        batchFailed = false;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (!started) {
        pending = Buffer.concat([pending, chunk]);
        while (!started && pending.length >= 4 && pending.length >= pending.readInt32BE(0)) {
          const len = pending.readInt32BE(0);
          const body = pending.subarray(4, len);
          pending = pending.subarray(len);
          if (body.readInt32BE(0) === 80877103) socket.write('N');
          else {
            started = true;
            onStartup(body);
          }
        }
        if (!started || pending.length === 0) return;
        chunk = pending;
      }
      for (const m of reader.push(chunk)) onMessage(m);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}
