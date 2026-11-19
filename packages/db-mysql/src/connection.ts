/**
 * One MySQL / MariaDB connection on `node:net` (and `node:tls`): login, text queries, prepared
 * statements, quit. Commands run one at a time. A server error (ERR packet) leaves the connection
 * usable; a broken stream or socket closes it for good.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { QueryResult } from '@pulpfixer/kit/db';
import { AuthFlow } from './auth.js';
import { frame, PacketParser, ProtocolError, Reader, type Packet } from './packet.js';
import {
  CLIENT,
  COM,
  command,
  handshakeResponse,
  isEof,
  MysqlError,
  parseAuthSwitch,
  parseEof,
  parseErr,
  parseHandshake,
  parseOk,
  parsePrepareOk,
  SERVER_MORE_RESULTS_EXISTS,
  sslRequest,
  stmtClose,
  stmtExecute,
  WANTED,
  type Ok,
} from './protocol.js';
import { decodeBinaryRow, decodeTextRow, encodeParam, parseColumn, type Column } from './types.js';

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  /** TLS with the server certificate verified against the host name. */
  tls: boolean;
  connectTimeoutMs?: number;
}

const CONNECT_TIMEOUT_MS = 10_000;

/** Packets in and out of one socket, with the sequence ids. */
class Wire {
  private parser = new PacketParser();
  private queue: Packet[] = [];
  private waiting: { resolve(p: Packet): void; reject(e: Error): void } | null = null;
  private failure: Error | null = null;
  private seq = 0;
  private detach: () => void = () => undefined;

  constructor(public socket: net.Socket) {
    this.attach(socket);
  }

  get failed(): boolean {
    return this.failure !== null;
  }

  private attach(socket: net.Socket): void {
    this.detach();
    const onData = (chunk: Buffer): void => {
      try {
        for (const p of this.parser.push(chunk)) this.deliver(p);
      } catch (e) {
        this.fail(e as Error);
      }
    };
    const onError = (e: Error): void => this.fail(e);
    const onClose = (): void => this.fail(new Error('the MySQL server closed the connection'));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    this.socket = socket;
    this.detach = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
  }

  private deliver(p: Packet): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(p);
    } else this.queue.push(p);
  }

  fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    const w = this.waiting;
    this.waiting = null;
    w?.reject(e);
    this.socket.destroy();
  }

  async next(): Promise<Buffer> {
    const queued = this.queue.shift();
    const p =
      queued ??
      (await new Promise<Packet>((resolve, reject) => {
        if (this.failure) return reject(this.failure);
        this.waiting = { resolve, reject };
      }));
    this.seq = (p.seq + 1) & 0xff;
    return p.payload;
  }

  /** Send one payload; `fresh` starts a new command (sequence id 0). */
  send(payload: Buffer, fresh = false): void {
    if (this.failure) throw this.failure;
    if (fresh) this.seq = 0;
    const f = frame(payload, this.seq);
    this.seq = f.seq;
    this.socket.write(f.bytes);
  }

  async upgrade(host: string): Promise<void> {
    const raw = this.socket;
    this.detach();
    raw.on('error', () => undefined);
    const secure = tls.connect({ socket: raw, host, ...(net.isIP(host) ? {} : { servername: host }) });
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(new Error(`TLS with ${host} failed: ${e.message}`));
      secure.once('error', onError);
      secure.once('secureConnect', () => {
        secure.off('error', onError);
        resolve();
      });
    });
    this.attach(secure);
  }

  /** End the socket; later use fails with `reason`. */
  async end(reason: Error): Promise<void> {
    const socket = this.socket;
    this.failure ??= reason;
    this.detach();
    socket.on('error', () => undefined);
    if (socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }
}

function okResult(ok: Ok): QueryResult {
  const insertId = typeof ok.insertId === 'bigint' ? ok.insertId.toString() : ok.insertId;
  return { rows: [], affected: Number(ok.affected), ...(insertId ? { insertId } : {}) };
}

interface OneResult {
  result: QueryResult;
  status: number;
  /** A row that could not be decoded; the result was still read to its end. */
  error?: unknown;
}

export class Connection {
  private chain: Promise<unknown> = Promise.resolve();
  private closed: Error | null = null;

  private constructor(
    private readonly wire: Wire,
    readonly serverVersion: string,
  ) {}

  static async open(o: MysqlOptions): Promise<Connection> {
    const ms = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const wire = new Wire(net.connect({ host: o.host, port: o.port }));
    wire.socket.setNoDelay(true);
    const timer = setTimeout(() => wire.fail(new Error(`timed out connecting to ${o.host}:${o.port} after ${ms / 1000} s`)), ms);
    try {
      const hs = parseHandshake(await wire.next());
      if (!(hs.capabilities & CLIENT.PROTOCOL_41)) throw new Error(`the server (${hs.serverVersion}) is too old: it lacks protocol 4.1`);
      let caps = (WANTED & hs.capabilities) | CLIENT.PROTOCOL_41;
      if (o.database) caps |= CLIENT.CONNECT_WITH_DB;
      if (o.tls) {
        if (!(hs.capabilities & CLIENT.SSL)) throw new Error('TLS was asked for, but the server does not offer it');
        caps |= CLIENT.SSL;
        wire.send(sslRequest(caps));
        await wire.upgrade(o.host);
      }
      const auth = new AuthFlow(o.password ?? '', o.tls);
      const first = auth.start(hs.plugin, hs.scramble);
      wire.send(handshakeResponse({ capabilities: caps, user: o.user, auth: first.data, ...(o.database ? { database: o.database } : {}), plugin: first.plugin }));
      for (;;) {
        const p = await wire.next();
        if (p[0] === 0x00) break;
        if (p[0] === 0xff) throw new MysqlError(parseErr(p));
        if (p[0] === 0xfe) {
          const s = parseAuthSwitch(p);
          wire.send(auth.switchTo(s.plugin, s.data));
        } else if (p[0] === 0x01) {
          const reply = auth.more(p.subarray(1));
          if (reply) wire.send(reply);
        } else throw new ProtocolError('unexpected packet during login');
      }
      return new Connection(wire, hs.serverVersion);
    } catch (e) {
      wire.fail(e as Error);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One statement as text (no values): COM_QUERY. */
  query(text: string): Promise<QueryResult> {
    return this.run(async () => {
      this.wire.send(command(COM.QUERY, text), true);
      return this.readResults(false);
    });
  }

  /** One statement with bound values: prepare, execute, close. */
  execute(text: string, values: readonly unknown[]): Promise<QueryResult> {
    return this.run(async () => {
      const params = values.map(encodeParam);
      this.wire.send(command(COM.STMT_PREPARE, text), true);
      const p = await this.wire.next();
      if (p[0] === 0xff) throw new MysqlError(parseErr(p));
      if (p[0] !== 0x00) throw new ProtocolError('unexpected reply to a prepare');
      const stmt = parsePrepareOk(p);
      await this.skipDefinitions(stmt.params);
      await this.skipDefinitions(stmt.columns);
      try {
        if (stmt.params !== params.length) {
          throw new Error(`the statement has ${stmt.params} placeholder${stmt.params === 1 ? '' : 's'} but ${params.length} value${params.length === 1 ? ' was' : 's were'} given`);
        }
        this.wire.send(stmtExecute(stmt.id, params), true);
        return await this.readResults(true);
      } finally {
        if (!this.wire.failed) this.wire.send(stmtClose(stmt.id), true);
      }
    });
  }

  /** Quit after the commands already queued. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = new Error('the MySQL connection is closed');
    await this.chain;
    if (!this.wire.failed) this.wire.send(command(COM.QUIT), true);
    await this.wire.end(this.closed);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      if (this.closed) throw this.closed;
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ProtocolError) this.wire.fail(e);
        throw e;
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async skipDefinitions(count: number): Promise<void> {
    if (count === 0) return;
    for (let i = 0; i < count; i++) await this.wire.next();
    if (!isEof(await this.wire.next())) throw new ProtocolError('expected EOF after the definitions');
  }

  /** Every result of one command; the first is returned, the rest (from CALL) are read and dropped. */
  private async readResults(binary: boolean): Promise<QueryResult> {
    let first: QueryResult | undefined;
    let error: unknown;
    for (;;) {
      const one = await this.readResult(binary);
      first ??= one.result;
      error ??= one.error;
      if (!(one.status & SERVER_MORE_RESULTS_EXISTS)) break;
    }
    if (error) throw error;
    return first!;
  }

  private async readResult(binary: boolean): Promise<OneResult> {
    const p = await this.wire.next();
    if (p[0] === 0x00) {
      const ok = parseOk(p);
      return { result: okResult(ok), status: ok.status };
    }
    if (p[0] === 0xff) throw new MysqlError(parseErr(p));
    if (p[0] === 0xfb) {
      this.wire.send(Buffer.alloc(0));
      const reply = await this.wire.next();
      const status = reply[0] === 0x00 ? parseOk(reply).status : 0;
      return {
        result: { rows: [] },
        status,
        error: new Error('the server asked for a local file (LOAD DATA LOCAL INFILE): pf never sends files'),
      };
    }
    const count = new Reader(p).lenenc() ?? 0;
    const columns: Column[] = [];
    for (let i = 0; i < count; i++) columns.push(parseColumn(await this.wire.next()));
    if (!isEof(await this.wire.next())) throw new ProtocolError('expected EOF after the column definitions');
    const rows: Record<string, unknown>[] = [];
    let error: unknown;
    for (;;) {
      const r = await this.wire.next();
      if (isEof(r)) return { result: { rows }, status: parseEof(r).status, ...(error ? { error } : {}) };
      if (r[0] === 0xff) throw new MysqlError(parseErr(r));
      if (error) continue;
      try {
        rows.push(binary ? decodeBinaryRow(columns, r) : decodeTextRow(columns, r));
      } catch (e) {
        error = e;
      }
    }
  }
}
