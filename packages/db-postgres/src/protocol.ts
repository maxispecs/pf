/**
 * The PostgreSQL wire protocol (version 3.0), as far as pf uses it: what the client sends (startup,
 * authentication, the extended query messages) and the parsing of what the server answers. Pure: no
 * sockets here. Every message is a type byte and a big-endian length that counts itself; the startup
 * and TLS requests have no type byte.
 */

export class ProtocolError extends Error {
  constructor(message: string) {
    super(`PostgreSQL protocol: ${message}`);
    this.name = 'ProtocolError';
  }
}

/** The fields of an ErrorResponse or NoticeResponse, by their one-letter codes. */
export type ErrorFields = Record<string, string>;

/** A server error. Same fields as node-postgres's `DatabaseError`; `code` is the SQLSTATE. */
const ERROR_FIELDS: [string, string][] = [
  ['severity', 'V'],
  ['code', 'C'],
  ['detail', 'D'],
  ['hint', 'H'],
  ['position', 'P'],
  ['where', 'W'],
  ['schema', 's'],
  ['table', 't'],
  ['column', 'c'],
  ['dataType', 'd'],
  ['constraint', 'n'],
];

export class PostgresError extends Error {
  declare readonly severity?: string;
  declare readonly code?: string;
  declare readonly detail?: string;
  declare readonly hint?: string;
  declare readonly position?: string;
  declare readonly where?: string;
  declare readonly schema?: string;
  declare readonly table?: string;
  declare readonly column?: string;
  declare readonly dataType?: string;
  declare readonly constraint?: string;

  constructor(fields: ErrorFields) {
    super(fields.M ?? 'unknown PostgreSQL error');
    this.name = 'PostgresError';
    const self = this as unknown as Record<string, string>;
    for (const [key, code] of ERROR_FIELDS) {
      // V is the severity that is never translated (9.6+); S is the localized one.
      const v = code === 'V' ? (fields.V ?? fields.S) : fields[code];
      if (v !== undefined) self[key] = v;
    }
  }

  /** The server ends the session after a FATAL or PANIC error. */
  get fatal(): boolean {
    return this.severity === 'FATAL' || this.severity === 'PANIC';
  }
}

export const PROTOCOL_VERSION = 3 << 16;
const SSL_REQUEST_CODE = 80877103;

export class Writer {
  private parts: Buffer[] = [];

  i16(v: number): this {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.parts.push(b);
    return this;
  }

  i32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.parts.push(b);
    return this;
  }

  bytes(v: Uint8Array): this {
    this.parts.push(Buffer.from(v));
    return this;
  }

  /** A NUL-terminated UTF-8 string. A NUL inside would end it early, so it is refused. */
  cstring(v: string): this {
    if (v.includes('\0')) throw new Error('PostgreSQL text cannot contain a NUL character');
    this.parts.push(Buffer.from(v, 'utf8'), Buffer.from([0]));
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** A typed message: type byte, length (including itself), body. */
export function message(type: string, body: Writer | Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.isBuffer(body) ? body : body.toBuffer();
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(b.length + 4, 1);
  return Buffer.concat([header, b]);
}

function untyped(body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeInt32BE(body.length + 4);
  return Buffer.concat([header, body]);
}

/** StartupMessage: protocol 3.0 and the session parameters (`user`, `database`, ...). */
export function startup(params: Record<string, string>): Buffer {
  const w = new Writer().i32(PROTOCOL_VERSION);
  for (const [k, v] of Object.entries(params)) w.cstring(k).cstring(v);
  return untyped(w.bytes(Buffer.from([0])).toBuffer());
}

/** SSLRequest: the server answers one unframed byte, `S` (start TLS) or `N`. */
export function sslRequest(): Buffer {
  return untyped(new Writer().i32(SSL_REQUEST_CODE).toBuffer());
}

/** PasswordMessage: a cleartext or MD5 password. */
export function password(value: string): Buffer {
  return message('p', new Writer().cstring(value));
}

export function saslInitial(mechanism: string, data: Buffer): Buffer {
  return message('p', new Writer().cstring(mechanism).i32(data.length).bytes(data));
}

export function saslResponse(data: Buffer): Buffer {
  return message('p', data);
}

/** Parse into the unnamed statement; the server infers every parameter type. */
export function parse(text: string): Buffer {
  return message('P', new Writer().cstring('').cstring(text).i16(0));
}

/** Bind the unnamed statement to the unnamed portal: text parameters (null is SQL NULL), text results. */
export function bind(values: readonly (Buffer | null)[]): Buffer {
  if (values.length > 0xffff) throw new Error(`PostgreSQL takes at most 65535 values in one statement, not ${values.length}`);
  const w = new Writer().cstring('').cstring('').i16(0).i16(values.length);
  for (const v of values) {
    if (v === null) w.i32(-1);
    else w.i32(v.length).bytes(v);
  }
  return message('B', w.i16(0));
}

export function describePortal(): Buffer {
  return message('D', new Writer().bytes(Buffer.from('P', 'latin1')).cstring(''));
}

/** Execute the unnamed portal, every row. */
export function execute(): Buffer {
  return message('E', new Writer().cstring('').i32(0));
}

export function sync(): Buffer {
  return message('S');
}

export function copyFail(reason: string): Buffer {
  return message('f', new Writer().cstring(reason));
}

export function terminate(): Buffer {
  return message('X');
}

/** One server message: its type character and its body (without type and length). */
export interface Message {
  type: string;
  body: Buffer;
}

/** Turns socket chunks into whole messages. */
export class MessageReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private needed = 5;

  push(chunk: Buffer): Message[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size < this.needed) return [];
    const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.size);
    const out: Message[] = [];
    let off = 0;
    while (buf.length - off >= 5) {
      const len = buf.readInt32BE(off + 1);
      if (len < 4) throw new ProtocolError(`a message has the invalid length ${len}`);
      if (buf.length - off < 1 + len) break;
      out.push({ type: String.fromCharCode(buf[off]!), body: buf.subarray(off + 5, off + 1 + len) });
      off += 1 + len;
    }
    const rest = buf.subarray(off);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    this.needed = rest.length >= 5 ? 1 + Math.max(4, rest.readInt32BE(1)) : 5;
    return out;
  }
}

export class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new ProtocolError('message ended early');
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  i16(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  rest(): Buffer {
    const v = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return v;
  }

  cstring(): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end === -1) throw new ProtocolError('a string has no terminator');
    const v = this.buf.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return v;
  }
}

export const AUTH = {
  OK: 0,
  KERBEROS_V5: 2,
  CLEARTEXT: 3,
  MD5: 5,
  GSS: 7,
  GSS_CONTINUE: 8,
  SSPI: 9,
  SASL: 10,
  SASL_CONTINUE: 11,
  SASL_FINAL: 12,
} as const;

export interface AuthRequest {
  code: number;
  /** MD5: the 4-byte salt. SASL continue / final: the server's message. */
  data: Buffer;
  /** SASL: the mechanisms the server offers. */
  mechanisms: string[];
}

export function parseAuth(body: Buffer): AuthRequest {
  const r = new Reader(body);
  const code = r.i32();
  if (code === AUTH.MD5) return { code, data: Buffer.from(r.bytes(4)), mechanisms: [] };
  if (code === AUTH.SASL) {
    const mechanisms: string[] = [];
    for (let m = r.cstring(); m !== ''; m = r.cstring()) mechanisms.push(m);
    return { code, data: Buffer.alloc(0), mechanisms };
  }
  return { code, data: Buffer.from(r.rest()), mechanisms: [] };
}

export function parseErrorFields(body: Buffer): ErrorFields {
  const r = new Reader(body);
  const fields: ErrorFields = {};
  for (let code = r.u8(); code !== 0; code = r.u8()) fields[String.fromCharCode(code)] = r.cstring();
  return fields;
}

export function parseParameterStatus(body: Buffer): [string, string] {
  const r = new Reader(body);
  return [r.cstring(), r.cstring()];
}

export interface Field {
  name: string;
  typeOid: number;
  /** 0 text, 1 binary. pf always asks for text. */
  format: number;
}

export function parseRowDescription(body: Buffer): Field[] {
  const r = new Reader(body);
  const n = r.i16();
  const fields: Field[] = [];
  for (let i = 0; i < n; i++) {
    const name = r.cstring();
    r.i32(); // table oid
    r.i16(); // column number
    const typeOid = r.i32() >>> 0;
    r.i16(); // type size
    r.i32(); // type modifier
    fields.push({ name, typeOid, format: r.i16() });
  }
  return fields;
}

/** The raw values of a DataRow; null is SQL NULL. */
export function parseDataRow(body: Buffer): (Buffer | null)[] {
  const r = new Reader(body);
  const n = r.i16();
  const values: (Buffer | null)[] = [];
  for (let i = 0; i < n; i++) {
    const len = r.i32();
    values.push(len === -1 ? null : r.bytes(len));
  }
  return values;
}

export interface CommandComplete {
  /** The first word of the tag: `SELECT`, `INSERT`, `UPDATE`, `CREATE`, ... */
  command: string;
  /** The row count the tag carries, null when it has none (`BEGIN`, `CREATE TABLE`). */
  rowCount: number | null;
}

/** `INSERT 0 3` (oid, then rows), `UPDATE 2`, `SELECT 5`, `BEGIN`, `CREATE TABLE`. */
export function parseCommandComplete(body: Buffer): CommandComplete {
  const tag = new Reader(body).cstring();
  const m = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?$/.exec(tag);
  if (!m) return { command: tag.split(' ')[0] ?? '', rowCount: null };
  const count = m[3] ?? m[2];
  return { command: m[1]!, rowCount: count === undefined ? null : Number(count) };
}
