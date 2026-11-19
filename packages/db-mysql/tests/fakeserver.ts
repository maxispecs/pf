/** A scripted MySQL server on node:net for the end-to-end tests: one connection, packets checked for their sequence ids. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { frame, PacketParser, Reader, Writer, type Packet } from '../src/packet.js';
import { CLIENT } from '../src/protocol.js';
import { TYPE } from '../src/types.js';

export const SERVER_CAPS =
  CLIENT.LONG_PASSWORD |
  CLIENT.FOUND_ROWS |
  CLIENT.LONG_FLAG |
  CLIENT.CONNECT_WITH_DB |
  CLIENT.PROTOCOL_41 |
  CLIENT.TRANSACTIONS |
  CLIENT.SECURE_CONNECTION |
  CLIENT.MULTI_RESULTS |
  CLIENT.PS_MULTI_RESULTS |
  CLIENT.PLUGIN_AUTH |
  CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA |
  CLIENT.LOCAL_FILES |
  CLIENT.MULTI_STATEMENTS;

export class Peer {
  private parser = new PacketParser();
  private queue: Packet[] = [];
  private waiting: ((p: Packet | null) => void) | null = null;
  private ended = false;
  private seq = 0;

  constructor(readonly socket: net.Socket) {
    socket.on('data', (d: Buffer) => {
      for (const p of this.parser.push(d)) {
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          w(p);
        } else this.queue.push(p);
      }
    });
    socket.on('close', () => {
      this.ended = true;
      this.waiting?.(null);
    });
    socket.on('error', () => undefined);
  }

  /** The next payload; null when the client hung up. `command` expects a new command (sequence id 0). */
  async next(command = false): Promise<Buffer | null> {
    const p = this.queue.shift() ?? (this.ended ? null : await new Promise<Packet | null>((r) => (this.waiting = r)));
    if (!p) return null;
    assert.equal(p.seq, command ? 0 : this.seq, 'sequence id from the client');
    this.seq = (p.seq + 1) & 0xff;
    return p.payload;
  }

  async must(command = false): Promise<Buffer> {
    const p = await this.next(command);
    assert.ok(p, 'the client hung up');
    return p;
  }

  send(...payloads: Buffer[]): void {
    for (const payload of payloads) {
      const f = frame(payload, this.seq);
      this.seq = f.seq;
      this.socket.write(f.bytes);
    }
  }
}

export const SCRAMBLE = Buffer.from('0123456789abcdefghij');

export function handshake(plugin = 'mysql_native_password', caps = SERVER_CAPS, scramble = SCRAMBLE): Buffer {
  return new Writer()
    .u8(10)
    .nulString('8.0.99-fake')
    .u32(42)
    .bytes(scramble.subarray(0, 8))
    .u8(0)
    .u16(caps & 0xffff)
    .u8(255)
    .u16(2)
    .u16(caps >>> 16)
    .u8(scramble.length + 1)
    .zeros(10)
    .bytes(scramble.subarray(8))
    .u8(0)
    .nulString(plugin)
    .toBuffer();
}

export interface Login {
  caps: number;
  user: string;
  auth: Buffer;
  database: string;
  plugin: string;
}

export function readLogin(payload: Buffer): Login {
  const r = new Reader(payload);
  const caps = r.u32();
  r.u32();
  r.u8();
  r.skip(23);
  const user = r.nulString();
  const auth = caps & CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA ? r.lenencBytes()! : r.bytes(r.u8());
  const database = caps & CLIENT.CONNECT_WITH_DB ? r.nulString() : '';
  const plugin = caps & CLIENT.PLUGIN_AUTH ? r.nulString() : '';
  return { caps, user, auth: Buffer.from(auth), database, plugin };
}

export const ok = (affected = 0, insertId = 0, status = 2): Buffer => new Writer().u8(0).lenenc(affected).lenenc(insertId).u16(status).u16(0).toBuffer();

export const err = (errno: number, state: string, message: string): Buffer =>
  new Writer().u8(0xff).u16(errno).u8(0x23).bytes(Buffer.from(state)).bytes(Buffer.from(message)).toBuffer();

export const eof = (status = 2): Buffer => new Writer().u8(0xfe).u16(0).u16(status).toBuffer();

export interface ColumnSpec {
  name: string;
  type: number;
  charset?: number;
  flags?: number;
  decimals?: number;
}

export function column(c: ColumnSpec): Buffer {
  return new Writer()
    .lenencString('def')
    .lenencString('app')
    .lenencString('t')
    .lenencString('t')
    .lenencString(c.name)
    .lenencString(c.name)
    .lenenc(0x0c)
    .u16(c.charset ?? 224)
    .u32(255)
    .u8(c.type)
    .u16(c.flags ?? 0)
    .u8(c.decimals ?? 0)
    .zeros(2)
    .toBuffer();
}

export function textRow(values: (string | Buffer | null)[]): Buffer {
  const w = new Writer();
  for (const v of values) {
    if (v === null) w.u8(0xfb);
    else w.lenencBytes(typeof v === 'string' ? Buffer.from(v) : v);
  }
  return w.toBuffer();
}

/** A text result set: column count, definitions, EOF, rows, EOF. */
export function resultSet(columns: ColumnSpec[], rows: (string | Buffer | null)[][], status = 2): Buffer[] {
  return [new Writer().lenenc(columns.length).toBuffer(), ...columns.map(column), eof(), ...rows.map(textRow), eof(status)];
}

export const PARAM_DEF = column({ name: '?', type: TYPE.VAR_STRING });

export interface Fake {
  port: number;
  /** Resolves when the script is done; rejects with its assertion failure. */
  done: Promise<void>;
  close(): void;
}

/** Serve one connection with `script`. */
export async function fakeServer(script: (peer: Peer) => Promise<void>): Promise<Fake> {
  let settle!: { resolve(): void; reject(e: unknown): void };
  const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  const server = net.createServer((socket) => {
    const peer = new Peer(socket);
    script(peer).then(
      () => {
        socket.end();
        settle.resolve();
      },
      (e) => {
        socket.destroy();
        settle.reject(e);
      },
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, done: done.finally(() => server.close()), close: () => server.close() };
}

/** Read commands until COM_QUIT or hang-up; `handle` answers each one. */
export async function serveCommands(peer: Peer, handle: (cmd: Buffer) => void | Promise<void>): Promise<void> {
  for (;;) {
    const cmd = await peer.next(true);
    if (!cmd || cmd[0] === 0x01) return;
    await handle(cmd);
  }
}
