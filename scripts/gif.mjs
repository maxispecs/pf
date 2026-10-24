// GIF decoding and PNG encoding shared by gif-frame.mjs and gif-art.mjs. No dependencies.

import zlib from 'node:zlib';

/** Decode LZW image data into color indexes. */
function lzw(data, minSize, count) {
  const out = new Uint8Array(count);
  const clear = 1 << minSize;
  const end = clear + 1;
  let size = minSize + 1;
  let next = end + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let prev = -1;
  let first = 0;
  let bits = 0;
  let acc = 0;
  let pos = 0;
  let o = 0;
  for (let i = 0; i < clear; i++) suffix[i] = i;
  for (const byte of data) {
    acc |= byte << bits;
    bits += 8;
    while (bits >= size) {
      let code = acc & ((1 << size) - 1);
      acc >>= size;
      bits -= size;
      if (code === clear) {
        size = minSize + 1;
        next = end + 1;
        prev = -1;
        continue;
      }
      if (code === end) return out;
      if (prev === -1) {
        out[o++] = suffix[code];
        prev = first = code;
        continue;
      }
      const incode = code;
      let sp = 0;
      if (code >= next) {
        stack[sp++] = first;
        code = prev;
      }
      while (code >= clear) {
        stack[sp++] = suffix[code];
        code = prefix[code];
      }
      first = suffix[code];
      stack[sp++] = first;
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = first;
        next++;
        if (next === 1 << size && size < 12) size++;
      }
      prev = incode;
      while (sp > 0 && o < count) out[o++] = stack[--sp];
      if (o >= count) return out;
    }
  }
  return out;
}

/** Parse the GIF into its canvas size and frames (rectangle, color indexes, palette, timing, disposal). */
export function parseGif(buf) {
  if (!/^GIF8[79]a/.test(buf.toString('latin1', 0, 6))) throw new Error('not a GIF file');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const flags = buf[10];
  let p = 13;
  let globalPalette = null;
  if (flags & 0x80) {
    const n = 2 << (flags & 7);
    globalPalette = buf.subarray(p, p + n * 3);
    p += n * 3;
  }
  const frames = [];
  let gce = { transparent: -1, disposal: 0, delay: 0 };
  const skipBlocks = () => {
    while (buf[p] !== 0) p += buf[p] + 1;
    p++;
  };
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) {
        const f = buf[p + 1];
        gce = { disposal: (f >> 2) & 7, transparent: f & 1 ? buf[p + 4] : -1, delay: buf.readUInt16LE(p + 2) };
      }
      skipBlocks();
    } else if (b === 0x2c) {
      const x = buf.readUInt16LE(p);
      const y = buf.readUInt16LE(p + 2);
      const w = buf.readUInt16LE(p + 4);
      const h = buf.readUInt16LE(p + 6);
      const f = buf[p + 8];
      p += 9;
      let palette = globalPalette;
      if (f & 0x80) {
        const n = 2 << (f & 7);
        palette = buf.subarray(p, p + n * 3);
        p += n * 3;
      }
      const minSize = buf[p++];
      const chunks = [];
      while (buf[p] !== 0) {
        chunks.push(buf.subarray(p + 1, p + 1 + buf[p]));
        p += buf[p] + 1;
      }
      p++;
      let idx = lzw(Buffer.concat(chunks), minSize, w * h);
      if (f & 0x40) {
        // Interlaced: rows come in four passes.
        const rows = new Uint8Array(w * h);
        let src = 0;
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let r = start; r < h; r += step) rows.set(idx.subarray(src * w, (src + 1) * w), r * w), src++;
        }
        idx = rows;
      }
      frames.push({ x, y, w, h, idx, palette, ...gce });
      gce = { transparent: -1, disposal: 0, delay: 0 };
    } else throw new Error(`unexpected block 0x${b.toString(16)} at ${p - 1}`);
  }
  if (!frames.length) throw new Error('the GIF has no frames');
  return { width, height, frames };
}

/** The full RGBA canvas as it looks when frame `n` is shown, applying earlier frames and their disposal. */
export function compose({ width, height, frames }, n) {
  let canvas = new Uint8Array(width * height * 4);
  let saved = null;
  for (let i = 0; i <= n; i++) {
    const fr = frames[i];
    if (fr.disposal === 3) saved = canvas.slice();
    for (let yy = 0; yy < fr.h; yy++) {
      for (let xx = 0; xx < fr.w; xx++) {
        const c = fr.idx[yy * fr.w + xx];
        const cx = fr.x + xx;
        const cy = fr.y + yy;
        if (c === fr.transparent || cx >= width || cy >= height || !fr.palette) continue;
        const o = (cy * width + cx) * 4;
        canvas[o] = fr.palette[c * 3];
        canvas[o + 1] = fr.palette[c * 3 + 1];
        canvas[o + 2] = fr.palette[c * 3 + 2];
        canvas[o + 3] = 255;
      }
    }
    if (i === n) break;
    if (fr.disposal === 2) {
      for (let yy = 0; yy < fr.h; yy++) canvas.fill(0, ((fr.y + yy) * width + fr.x) * 4, ((fr.y + yy) * width + fr.x + fr.w) * 4);
    } else if (fr.disposal === 3 && saved) canvas = saved;
  }
  return canvas;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** Encode RGBA pixels as a PNG. */
export function encodePng(px, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(px.buffer, px.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
