/** The MySQL client/server messages this driver reads and writes. Pure: buffers in, buffers out. */
import { ProtocolError, Reader, Writer } from './packet.js';
import type { Param } from './types.js';

export const CLIENT = {
  LONG_PASSWORD: 1,
  FOUND_ROWS: 2,
  LONG_FLAG: 4,
  CONNECT_WITH_DB: 8,
  LOCAL_FILES: 128,
  PROTOCOL_41: 512,
  SSL: 2048,
  TRANSACTIONS: 8192,
  SECURE_CONNECTION: 32768,
  MULTI_STATEMENTS: 1 << 16,
  MULTI_RESULTS: 1 << 17,
  PS_MULTI_RESULTS: 1 << 18,
  PLUGIN_AUTH: 1 << 19,
  PLUGIN_AUTH_LENENC_CLIENT_DATA: 1 << 21,
  DEPRECATE_EOF: 1 << 24,
} as const;

export const SERVER_MORE_RESULTS_EXISTS = 0x0008;

export const COM = { QUIT: 0x01, QUERY: 0x03, STMT_PREPARE: 0x16, STMT_EXECUTE: 0x17, STMT_CLOSE: 0x19 } as const;

/** utf8mb4_unicode_ci: known to MySQL and MariaDB alike. */
export const COLLATION_UTF8MB4 = 224;

/**
 * What the client asks for. LOCAL_FILES (the server could ask for a file), MULTI_STATEMENTS (one string,
 * several statements) and DEPRECATE_EOF are never set.
 */
export const WANTED =
  CLIENT.LONG_PASSWORD |
  CLIENT.FOUND_ROWS |
  CLIENT.LONG_FLAG |
  CLIENT.PROTOCOL_41 |
  CLIENT.TRANSACTIONS |
  CLIENT.SECURE_CONNECTION |
  CLIENT.MULTI_RESULTS |
  CLIENT.PS_MULTI_RESULTS |
  CLIENT.PLUGIN_AUTH |
  CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA;

export interface Handshake {
  serverVersion: string;
  connectionId: number;
  capabilities: number;
  /** The nonce for the auth plugin (20 bytes for the stock plugins). */
  scramble: Buffer;
  plugin: string;
}

export function parseHandshake(payload: Buffer): Handshake {
  if (payload[0] === 0xff) throw new MysqlError(parseErr(payload));
  const r = new Reader(payload);
  const version = r.u8();
  if (version !== 10) throw new ProtocolError(`unsupported handshake version ${version}`);
  const serverVersion = r.nulString();
  const connectionId = r.u32();
  const part1 = r.bytes(8);
  r.skip(1);
  let capabilities = r.u16();
  let part2: Buffer = Buffer.alloc(0);
  let plugin = '';
  if (r.remaining > 0) {
    r.u8(); // charset
    r.u16(); // status
    capabilities |= r.u16() << 16;
    capabilities >>>= 0;
    const authLen = r.u8();
    r.skip(10);
    if (capabilities & CLIENT.SECURE_CONNECTION) {
      part2 = r.bytes(Math.min(r.remaining, Math.max(13, authLen - 8)));
      if (part2.length && part2[part2.length - 1] === 0) part2 = part2.subarray(0, part2.length - 1);
    }
    if (capabilities & CLIENT.PLUGIN_AUTH) plugin = r.nulString();
  }
  return { serverVersion, connectionId, capabilities, scramble: Buffer.concat([part1, part2]), plugin: plugin || 'mysql_native_password' };
}

const MAX_PACKET = 0x40000000;

function loginHeader(w: Writer, capabilities: number): Writer {
  return w.u32(capabilities).u32(MAX_PACKET).u8(COLLATION_UTF8MB4).zeros(23);
}

export function sslRequest(capabilities: number): Buffer {
  return loginHeader(new Writer(), capabilities).toBuffer();
}

export interface LoginResponse {
  capabilities: number;
  user: string;
  auth: Buffer;
  database?: string;
  plugin: string;
}

export function handshakeResponse(o: LoginResponse): Buffer {
  const w = loginHeader(new Writer(), o.capabilities).nulString(o.user);
  if (o.capabilities & CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA) w.lenencBytes(o.auth);
  else w.u8(o.auth.length).bytes(o.auth);
  if (o.capabilities & CLIENT.CONNECT_WITH_DB) w.nulString(o.database ?? '');
  if (o.capabilities & CLIENT.PLUGIN_AUTH) w.nulString(o.plugin);
  return w.toBuffer();
}

export interface Ok {
  affected: number | bigint;
  insertId: number | bigint;
  status: number;
  warnings: number;
}

export function parseOk(payload: Buffer): Ok {
  const r = new Reader(payload);
  r.u8();
  const affected = r.lenencBig() ?? 0;
  const insertId = r.lenencBig() ?? 0;
  const status = r.remaining >= 2 ? r.u16() : 0;
  const warnings = r.remaining >= 2 ? r.u16() : 0;
  return { affected, insertId, status, warnings };
}

export interface Err {
  errno: number;
  sqlState?: string;
  message: string;
}

export function parseErr(payload: Buffer): Err {
  const r = new Reader(payload);
  r.u8();
  const errno = r.u16();
  let sqlState: string | undefined;
  if (r.remaining > 0 && payload[r.pos] === 0x23) {
    r.skip(1);
    sqlState = r.bytes(5).toString('latin1');
  }
  return { errno, ...(sqlState ? { sqlState } : {}), message: r.rest().toString('utf8') };
}

export function isEof(payload: Buffer): boolean {
  return payload[0] === 0xfe && payload.length < 9;
}

export function parseEof(payload: Buffer): { warnings: number; status: number } {
  const r = new Reader(payload);
  r.u8();
  return r.remaining >= 4 ? { warnings: r.u16(), status: r.u16() } : { warnings: 0, status: 0 };
}

export function parseAuthSwitch(payload: Buffer): { plugin: string; data: Buffer } {
  const r = new Reader(payload);
  r.u8();
  const plugin = r.nulString();
  return { plugin, data: r.rest() };
}

const ERROR_NAMES: Record<number, string> = {
  1040: 'ER_CON_COUNT_ERROR',
  1044: 'ER_DBACCESS_DENIED_ERROR',
  1045: 'ER_ACCESS_DENIED_ERROR',
  1048: 'ER_BAD_NULL_ERROR',
  1049: 'ER_BAD_DB_ERROR',
  1054: 'ER_BAD_FIELD_ERROR',
  1062: 'ER_DUP_ENTRY',
  1064: 'ER_PARSE_ERROR',
  1105: 'ER_UNKNOWN_ERROR',
  1130: 'ER_HOST_NOT_PRIVILEGED',
  1142: 'ER_TABLEACCESS_DENIED_ERROR',
  1146: 'ER_NO_SUCH_TABLE',
  1205: 'ER_LOCK_WAIT_TIMEOUT',
  1210: 'ER_WRONG_ARGUMENTS',
  1213: 'ER_LOCK_DEADLOCK',
  1227: 'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  1251: 'ER_NOT_SUPPORTED_AUTH_MODE',
  1290: 'ER_OPTION_PREVENTS_STATEMENT',
  1295: 'ER_UNSUPPORTED_PS',
  1366: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
  1406: 'ER_DATA_TOO_LONG',
  1451: 'ER_ROW_IS_REFERENCED_2',
  1452: 'ER_NO_REFERENCED_ROW_2',
  1820: 'ER_MUST_CHANGE_PASSWORD',
  1862: 'ER_MUST_CHANGE_PASSWORD_LOGIN',
  3159: 'ER_SECURE_TRANSPORT_REQUIRED',
};

export class MysqlError extends Error {
  readonly code: string;
  readonly errno: number;
  readonly sqlState?: string;
  constructor(e: Err) {
    super(e.message);
    this.name = 'MysqlError';
    this.code = ERROR_NAMES[e.errno] ?? `MYSQL_${e.errno}`;
    this.errno = e.errno;
    if (e.sqlState) this.sqlState = e.sqlState;
  }
}

export const command = (code: number, body: Buffer | string = Buffer.alloc(0)): Buffer =>
  Buffer.concat([Buffer.from([code]), typeof body === 'string' ? Buffer.from(body, 'utf8') : body]);

export function stmtClose(id: number): Buffer {
  return new Writer().u8(COM.STMT_CLOSE).u32(id).toBuffer();
}

/** COM_STMT_EXECUTE for statement `id`, no cursor, its values bound with their types. */
export function stmtExecute(id: number, params: Param[]): Buffer {
  const w = new Writer().u8(COM.STMT_EXECUTE).u32(id).u8(0).u32(1);
  if (params.length === 0) return w.toBuffer();
  const bitmap = Buffer.alloc((params.length + 7) >> 3);
  params.forEach((p, i) => {
    if (p.value === null) bitmap[i >> 3]! |= 1 << (i & 7);
  });
  w.bytes(bitmap).u8(1);
  for (const p of params) w.u8(p.type).u8(p.unsigned ? 0x80 : 0);
  for (const p of params) if (p.value) w.bytes(p.value);
  return w.toBuffer();
}

export interface PrepareOk {
  id: number;
  columns: number;
  params: number;
}

export function parsePrepareOk(payload: Buffer): PrepareOk {
  const r = new Reader(payload);
  r.u8();
  const id = r.u32();
  const columns = r.u16();
  const params = r.u16();
  return { id, columns, params };
}
