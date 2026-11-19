/**
 * MySQL packets: little-endian integers, length-encoded integers and strings, and the framing (3-byte
 * length + sequence id, a payload of 16 MB - 1 or more continues in the next packet).
 */

/** The largest payload one packet carries. A payload of exactly this length continues in the next packet. */
export const MAX_PAYLOAD = 0xffffff;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(`MySQL protocol: ${message}`);
    this.name = 'ProtocolError';
  }
}

export class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new ProtocolError('packet ended early');
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u24(): number {
    this.need(3);
    const v = this.buf.readUIntLE(this.pos, 3);
    this.pos += 3;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  i8(): number {
    this.need(1);
    return this.buf.readInt8(this.pos++);
  }

  i16(): number {
    this.need(2);
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  rest(): Buffer {
    const v = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return v;
  }

  /** A length-encoded integer: null for the NULL marker 0xFB. A value beyond 2^53 is a bigint. */
  lenencBig(): bigint | number | null {
    const first = this.u8();
    if (first < 0xfb) return first;
    if (first === 0xfb) return null;
    if (first === 0xfc) return this.u16();
    if (first === 0xfd) return this.u24();
    if (first === 0xfe) {
      const v = this.u64();
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new ProtocolError('0xFF is not a length-encoded integer');
  }

  /** A length-encoded integer that must fit a number (lengths, counts). */
  lenenc(): number | null {
    const v = this.lenencBig();
    if (typeof v === 'bigint') throw new ProtocolError('a length is beyond 2^53');
    return v;
  }

  lenencBytes(): Buffer | null {
    const n = this.lenenc();
    return n === null ? null : this.bytes(n);
  }

  lenencString(): string {
    return this.lenencBytes()?.toString('utf8') ?? '';
  }

  /** A NUL-terminated string; a missing NUL ends it at the end of the packet. */
  nulString(): string {
    const end = this.buf.indexOf(0, this.pos);
    const stop = end === -1 ? this.buf.length : end;
    const v = this.buf.toString('utf8', this.pos, stop);
    this.pos = end === -1 ? stop : stop + 1;
    return v;
  }
}

export class Writer {
  private buf = Buffer.alloc(64);
  private len = 0;

  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  u8(v: number): this {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.grow(2);
    this.buf.writeUInt16LE(v, this.len);
    this.len += 2;
    return this;
  }

  u24(v: number): this {
    this.grow(3);
    this.buf.writeUIntLE(v, this.len, 3);
    this.len += 3;
    return this;
  }

  u32(v: number): this {
    this.grow(4);
    this.buf.writeUInt32LE(v >>> 0, this.len);
    this.len += 4;
    return this;
  }

  u64(v: bigint): this {
    this.grow(8);
    this.buf.writeBigUInt64LE(v, this.len);
    this.len += 8;
    return this;
  }

  i64(v: bigint): this {
    this.grow(8);
    this.buf.writeBigInt64LE(v, this.len);
    this.len += 8;
    return this;
  }

  f64(v: number): this {
    this.grow(8);
    this.buf.writeDoubleLE(v, this.len);
    this.len += 8;
    return this;
  }

  bytes(v: Uint8Array): this {
    this.grow(v.length);
    this.buf.set(v, this.len);
    this.len += v.length;
    return this;
  }

  zeros(n: number): this {
    this.grow(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  nulString(v: string): this {
    return this.bytes(Buffer.from(v, 'utf8')).u8(0);
  }

  lenenc(n: number): this {
    if (n < 0xfb) return this.u8(n);
    if (n <= 0xffff) return this.u8(0xfc).u16(n);
    if (n <= 0xffffff) return this.u8(0xfd).u24(n);
    return this.u8(0xfe).u64(BigInt(n));
  }

  lenencBytes(v: Uint8Array): this {
    return this.lenenc(v.length).bytes(v);
  }

  lenencString(v: string): this {
    return this.lenencBytes(Buffer.from(v, 'utf8'));
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

/** One payload as wire packets, starting at sequence id `seq`. Returns the bytes and the next sequence id. */
export function frame(payload: Buffer, seq: number): { bytes: Buffer; seq: number } {
  const parts: Buffer[] = [];
  let off = 0;
  for (;;) {
    const n = Math.min(MAX_PAYLOAD, payload.length - off);
    const header = Buffer.alloc(4);
    header.writeUIntLE(n, 0, 3);
    header[3] = seq & 0xff;
    seq = (seq + 1) & 0xff;
    parts.push(header, payload.subarray(off, off + n));
    off += n;
    if (n < MAX_PAYLOAD) break;
  }
  return { bytes: Buffer.concat(parts), seq };
}

export interface Packet {
  /** Sequence id of the last wire packet of this payload. */
  seq: number;
  payload: Buffer;
}

/** Turns socket chunks into whole payloads, joining the packets of a payload of 16 MB or more. */
export class PacketParser {
  private chunks: Buffer[] = [];
  private size = 0;
  private needed = 4;
  private parts: Buffer[] = [];

  push(chunk: Buffer): Packet[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size < this.needed) return [];
    const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.size);
    const out: Packet[] = [];
    let off = 0;
    while (buf.length - off >= 4) {
      const len = buf.readUIntLE(off, 3);
      if (buf.length - off < 4 + len) break;
      const seq = buf[off + 3]!;
      this.parts.push(buf.subarray(off + 4, off + 4 + len));
      off += 4 + len;
      if (len < MAX_PAYLOAD) {
        out.push({ seq, payload: this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts) });
        this.parts = [];
      }
    }
    const rest = buf.subarray(off);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    this.needed = rest.length >= 4 ? 4 + rest.readUIntLE(0, 3) : 4;
    return out;
  }
}
