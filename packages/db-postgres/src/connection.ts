/**
 * One PostgreSQL connection on `node:net` (and `node:tls`): TLS negotiation, startup and password
 * authentication, statements through the extended query protocol, terminate. Statements run one at a
 * time. A server error leaves the connection usable (the server is back at ReadyForQuery); a FATAL error,
 * a broken stream or a closed socket ends it for good.
 */
import net from 'node:net';
import tls from 'node:tls';
import { md5Password, SCRAM_SHA_256, ScramClient } from './auth.js';
import type { PgOptions } from './config.js';
import {
  AUTH,
  bind,
  copyFail,
  describePortal,
  execute,
  flush,
  MessageReader,
  parse,
  parseAuth,
  parseCommandComplete,
  parseDataRow,
  parseErrorFields,
  parseParameterStatus,
  parseRowDescription,
  password as passwordMessage,
  PostgresError,
  ProtocolError,
  saslInitial,
  saslResponse,
  sslRequest,
  startup,
  sync,
  terminate,
  type Field,
  type Message,
} from './protocol.js';
import { decodeRow, encodeParam } from './types.js';

const CONNECT_TIMEOUT_MS = 10_000;

const AUTH_NAMES: Record<number, string> = {
  [AUTH.KERBEROS_V5]: 'Kerberos V5',
  [AUTH.GSS]: 'GSSAPI',
  [AUTH.GSS_CONTINUE]: 'GSSAPI',
  [AUTH.SSPI]: 'SSPI',
};

type Waiter = { resolve(v: unknown): void; reject(e: Error): void };

/** Messages in and out of one socket. */
class Wire {
  private reader = new MessageReader();
  private queue: Message[] = [];
  private waiting: Waiter | null = null;
  private failure: Error | null = null;
  /** The answer to an SSLRequest is one unframed byte. */
  private expectByte = false;
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
        if (this.expectByte) {
          this.expectByte = false;
          // Bytes after the answer would be read as if they came over TLS (CVE-2021-23214).
          if (chunk.length !== 1) throw new ProtocolError('the server answered the TLS request with more than one byte');
          this.settle((w) => w.resolve(chunk[0]));
          return;
        }
        for (const m of this.reader.push(chunk)) this.deliver(m);
      } catch (e) {
        this.fail(e as Error);
      }
    };
    const onError = (e: Error): void => this.fail(e);
    const onClose = (): void => this.fail(new Error('the PostgreSQL server closed the connection'));
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

  private settle(fn: (w: Waiter) => void): void {
    const w = this.waiting;
    this.waiting = null;
    if (w) fn(w);
  }

  private wait<T>(): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.waiting = { resolve: resolve as (v: unknown) => void, reject };
    });
  }

  private deliver(m: Message): void {
    if (this.waiting) this.settle((w) => w.resolve(m));
    else this.queue.push(m);
  }

  fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    this.settle((w) => w.reject(e));
    this.socket.destroy();
  }

  async next(): Promise<Message> {
    return this.queue.shift() ?? this.wait<Message>();
  }

  /** The one-byte answer to an SSLRequest: `S` or `N`. */
  async sslAnswer(): Promise<number> {
    this.send(sslRequest());
    this.expectByte = true;
    return this.wait<number>();
  }

  send(bytes: Buffer): void {
    if (this.failure) throw this.failure;
    this.socket.write(bytes);
  }

  async upgrade(host: string): Promise<void> {
    const raw = this.socket;
    this.detach();
    raw.on('error', () => undefined);
    const secure = tls.connect({ socket: raw, host, ...(net.isIP(host) ? {} : { servername: host }) });
    const done = this.wait<void>();
    const onError = (e: Error): void => this.fail(new Error(`TLS with ${host} failed: ${e.message}`));
    const onClose = (): void => this.fail(new Error(`TLS with ${host} failed: the connection closed`));
    secure.once('error', onError);
    secure.once('close', onClose);
    secure.once('secureConnect', () => this.settle((w) => w.resolve(undefined)));
    try {
      await done;
    } finally {
      secure.off('error', onError);
      secure.off('close', onClose);
    }
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

/** What one statement gave back. */
export interface PgResult {
  /** The first word of the command tag (`SELECT`, `INSERT`, `UPDATE`, ...), empty for an empty query. */
  command: string;
  rowCount: number | null;
  rows: Record<string, unknown>[];
}

function needPassword(o: PgOptions): string {
  if (o.password === undefined) throw new Error(`the server asks for a password for "${o.user}", but the connection has none`);
  return o.password;
}

async function authenticate(wire: Wire, o: PgOptions): Promise<void> {
  let scram: ScramClient | null = null;
  for (;;) {
    const m = await wire.next();
    if (m.type === 'E') throw new PostgresError(parseErrorFields(m.body));
    if (m.type === 'N') continue;
    if (m.type !== 'R') throw new ProtocolError(`unexpected message "${m.type}" during login`);
    const a = parseAuth(m.body);
    switch (a.code) {
      case AUTH.OK:
        if (scram && !scram.verified) throw new Error('SCRAM: the server ended the login without proving that it knows the password');
        return;
      case AUTH.CLEARTEXT:
        wire.send(passwordMessage(needPassword(o)));
        break;
      case AUTH.MD5:
        wire.send(passwordMessage(md5Password(o.user, needPassword(o), a.data)));
        break;
      case AUTH.SASL:
        if (!a.mechanisms.includes(SCRAM_SHA_256)) {
          throw new Error(`the server offers SASL mechanisms pf does not support (${a.mechanisms.join(', ')}; pf supports ${SCRAM_SHA_256})`);
        }
        scram = new ScramClient(needPassword(o));
        wire.send(saslInitial(SCRAM_SHA_256, scram.first()));
        break;
      case AUTH.SASL_CONTINUE:
        if (!scram) throw new ProtocolError('SASL data before SASL started');
        wire.send(saslResponse(scram.final(a.data.toString('utf8'))));
        break;
      case AUTH.SASL_FINAL:
        if (!scram) throw new ProtocolError('SASL data before SASL started');
        scram.verify(a.data.toString('utf8'));
        break;
      default:
        throw new Error(`the server asks for ${AUTH_NAMES[a.code] ?? `authentication method ${a.code}`}, which pf does not support (supported: password, md5, scram-sha-256)`);
    }
  }
}

export class PgConnection {
  private chain: Promise<unknown> = Promise.resolve();
  private closed: Error | null = null;

  private constructor(
    private readonly wire: Wire,
    /** What the server reported with ParameterStatus (`server_version`, `TimeZone`, ...). */
    readonly parameters: Map<string, string>,
  ) {}

  static async open(o: PgOptions): Promise<PgConnection> {
    const ms = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const where = o.socketPath ?? `${o.host}:${o.port}`;
    const wire = new Wire(o.socketPath ? net.connect({ path: o.socketPath }) : net.connect({ host: o.host, port: o.port }));
    if (!o.socketPath) wire.socket.setNoDelay(true);
    const timer = ms > 0 ? setTimeout(() => wire.fail(new Error(`timed out connecting to ${where} after ${ms / 1000} s`)), ms) : undefined;
    try {
      if (o.tls !== 'off' && !o.socketPath) {
        const answer = await wire.sslAnswer();
        if (answer === 0x53) await wire.upgrade(o.host);
        else if (answer !== 0x4e) throw new ProtocolError('unexpected answer to the TLS request');
        else if (o.tls === 'require') throw new Error('TLS was asked for, but the server does not offer it');
      }
      wire.send(
        startup({
          user: o.user,
          database: o.database,
          client_encoding: 'UTF8',
          DateStyle: 'ISO, MDY',
          application_name: o.applicationName ?? 'pf',
        }),
      );
      await authenticate(wire, o);
      const parameters = new Map<string, string>();
      for (;;) {
        const m = await wire.next();
        if (m.type === 'Z') break;
        if (m.type === 'S') parameters.set(...parseParameterStatus(m.body));
        else if (m.type === 'E') throw new PostgresError(parseErrorFields(m.body));
        else if (m.type !== 'K' && m.type !== 'N') throw new ProtocolError(`unexpected message "${m.type}" after login`);
      }
      return new PgConnection(wire, parameters);
    } catch (e) {
      wire.fail(e as Error);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One statement with its values bound as `$1`, `$2`, ... */
  query(text: string, values: readonly unknown[] = []): Promise<PgResult> {
    return this.run(async () => {
      const params = values.map(encodeParam);
      this.wire.send(Buffer.concat([parse(text), bind(params), describePortal(), execute(), sync()]));
      let fields: Field[] = [];
      const rows: Record<string, unknown>[] = [];
      let command = '';
      let rowCount: number | null = null;
      let error: Error | null = null;
      for (;;) {
        const m = await this.wire.next();
        switch (m.type) {
          case 'T':
            fields = parseRowDescription(m.body);
            break;
          case 'D':
            if (error) break;
            try {
              rows.push(decodeRow(fields, parseDataRow(m.body)));
            } catch (e) {
              error = e as Error;
            }
            break;
          case 'C':
            ({ command, rowCount } = parseCommandComplete(m.body));
            break;
          case 'E': {
            const e = new PostgresError(parseErrorFields(m.body));
            if (e.fatal) throw e;
            error ??= e;
            break;
          }
          case 'G':
            // COPY ... FROM STDIN: the server ignores Sync while it waits for data, so refuse and sync again.
            this.wire.send(Buffer.concat([copyFail('pf does not support COPY'), sync()]));
            break;
          case 'H':
          case 'W':
            error ??= new Error('pf does not support COPY');
            break;
          case 'Z':
            if (error) throw error;
            return { command, rowCount, rows };
          case '1': // ParseComplete
          case '2': // BindComplete
          case 'n': // NoData
          case 'I': // EmptyQueryResponse
          case 's': // PortalSuspended
          case 'd': // CopyData
          case 'c': // CopyDone
          case 'N': // NoticeResponse
          case 'A': // NotificationResponse
            break;
          case 'S':
            this.parameters.set(...parseParameterStatus(m.body));
            break;
          default:
            throw new ProtocolError(`unexpected message "${m.type}"`);
        }
      }
    });
  }

  /**
   * One statement that reads, as batches of at most `batchSize` rows. The rows are fetched a batch at a
   * time from one portal (Execute with a row limit), so a big result is never held whole. The connection
   * is used by this statement until the iteration ends: finish it or stop it (`return()`, which `for await`
   * does on `break`), and other statements wait their turn meanwhile.
   */
  stream(text: string, values: readonly unknown[], batchSize: number): AsyncGenerator<Record<string, unknown>[]> {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('the batch size must be a whole number of at least 1');
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return (async function* () {
      const prev = self.chain;
      let release: () => void = () => undefined;
      self.chain = prev.then(() => new Promise<void>((resolve) => (release = resolve)));
      await prev;
      if (self.closed) {
        release();
        throw self.closed;
      }
      const wire = self.wire;
      let phase: 'open' | 'syncing' | 'done' = 'open';
      try {
        wire.send(Buffer.concat([parse(text), bind(values.map(encodeParam)), describePortal(), execute(batchSize), flush()]));
        let fields: Field[] = [];
        let batch: Record<string, unknown>[] = [];
        let error: Error | null = null;
        const endPortal = (): void => {
          if (phase !== 'open') return;
          phase = 'syncing';
          wire.send(sync());
        };
        for (;;) {
          const m = await wire.next();
          switch (m.type) {
            case 'T':
              fields = parseRowDescription(m.body);
              break;
            case 'D':
              if (error) break;
              try {
                batch.push(decodeRow(fields, parseDataRow(m.body)));
              } catch (e) {
                error = e as Error;
                endPortal();
              }
              break;
            case 's': // PortalSuspended: a full batch
              if (error || phase !== 'open') break;
              if (batch.length > 0) {
                const full = batch;
                batch = [];
                yield full;
              }
              if (phase === 'open') wire.send(Buffer.concat([execute(batchSize), flush()]));
              break;
            case 'C':
              endPortal();
              break;
            case 'E': {
              const e = new PostgresError(parseErrorFields(m.body));
              if (e.fatal) throw e;
              error ??= e;
              // After an error the server skips everything up to Sync.
              endPortal();
              break;
            }
            case 'G':
              wire.send(Buffer.concat([copyFail('pf does not support COPY'), sync()]));
              phase = 'syncing';
              break;
            case 'H':
            case 'W':
              error ??= new Error('pf does not support COPY');
              endPortal();
              break;
            case 'Z':
              phase = 'done';
              if (error) throw error;
              if (batch.length > 0) yield batch;
              return;
            case '1': // ParseComplete
            case '2': // BindComplete
            case 'n': // NoData
            case 'I': // EmptyQueryResponse
            case 'd': // CopyData
            case 'c': // CopyDone
            case 'N': // NoticeResponse
            case 'A': // NotificationResponse
              break;
            case 'S':
              self.parameters.set(...parseParameterStatus(m.body));
              break;
            default:
              throw new ProtocolError(`unexpected message "${m.type}"`);
          }
        }
      } catch (e) {
        if (e instanceof ProtocolError || (e instanceof PostgresError && e.fatal)) wire.fail(e);
        throw e;
      } finally {
        try {
          // Stopped early (or failed): close the portal and read up to ReadyForQuery so the connection is clean.
          if (phase === 'open' && !wire.failed) {
            phase = 'syncing';
            wire.send(sync());
          }
          while (phase === 'syncing' && !wire.failed) {
            if ((await wire.next()).type === 'Z') phase = 'done';
          }
        } catch {
          // the connection is gone; nothing to clean
        } finally {
          release();
        }
      }
    })();
  }

  /** Terminate after the statements already queued. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = new Error('the PostgreSQL connection is closed');
    await this.chain;
    if (!this.wire.failed) this.wire.send(terminate());
    await this.wire.end(this.closed);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      if (this.closed) throw this.closed;
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ProtocolError || (e instanceof PostgresError && e.fatal)) this.wire.fail(e);
        throw e;
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
