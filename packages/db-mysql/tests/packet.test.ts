import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frame, MAX_PAYLOAD, PacketParser, Reader, Writer } from '../src/packet.js';

test('length-encoded integers round-trip at every width', () => {
  for (const n of [0, 250, 251, 0xffff, 0x10000, 0xffffff, 0x1000000, Number.MAX_SAFE_INTEGER]) {
    const r = new Reader(new Writer().lenenc(n).toBuffer());
    assert.equal(r.lenenc(), n);
    assert.equal(r.remaining, 0);
  }
  assert.deepEqual(
    [0xfc, 0xfd, 0xfe].map((m) => new Writer().lenenc(m === 0xfc ? 300 : m === 0xfd ? 70000 : 2 ** 40).toBuffer()[0]),
    [0xfc, 0xfd, 0xfe],
  );
  assert.equal(new Reader(Buffer.from([0xfb])).lenenc(), null, '0xFB is NULL');
  const huge = new Reader(new Writer().u8(0xfe).u64(2n ** 63n).toBuffer());
  assert.equal(huge.lenencBig(), 2n ** 63n);
  assert.throws(() => new Reader(Buffer.from([0xff])).lenenc(), /not a length-encoded/);
  assert.throws(() => new Reader(Buffer.from([0xfc, 1])).lenenc(), /ended early/);
});

test('strings: length-encoded and NUL-terminated', () => {
  const r = new Reader(new Writer().lenencString('héllo').nulString('a').toBuffer());
  assert.equal(r.lenencString(), 'héllo');
  assert.equal(r.nulString(), 'a');
  assert.equal(new Reader(Buffer.from('tail')).nulString(), 'tail', 'a missing NUL ends at the packet end');
});

test('framing: header, sequence ids, and the parser across chunk boundaries', () => {
  const a = frame(Buffer.from('abc'), 3);
  assert.deepEqual([...a.bytes.subarray(0, 4)], [3, 0, 0, 3]);
  assert.equal(a.seq, 4);
  const b = frame(Buffer.from('defg'), a.seq);
  const wire = Buffer.concat([a.bytes, b.bytes]);
  const parser = new PacketParser();
  const out = [...wire].flatMap((byte) => parser.push(Buffer.from([byte])));
  assert.deepEqual(
    out.map((p) => [p.seq, p.payload.toString()]),
    [
      [3, 'abc'],
      [4, 'defg'],
    ],
  );
  assert.equal(frame(Buffer.alloc(0), 255).seq, 0, 'sequence ids wrap');
});

test('a payload of 16 MB or more is split and joined again', () => {
  for (const size of [MAX_PAYLOAD, MAX_PAYLOAD + 10]) {
    const payload = Buffer.alloc(size, 7);
    payload[size - 1] = 9;
    const f = frame(payload, 0);
    const packets = 2;
    assert.equal(f.seq, packets, 'a full packet, then the rest (empty for an exact multiple)');
    const parser = new PacketParser();
    const out = [];
    for (let i = 0; i < f.bytes.length; i += 65536) out.push(...parser.push(f.bytes.subarray(i, i + 65536)));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.payload.length, size);
    assert.equal(out[0]!.payload[size - 1], 9);
    assert.equal(out[0]!.seq, packets - 1);
  }
});
