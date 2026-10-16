#!/usr/bin/env node
// Turn assets/pulpfixer.png into the dotted (braille) header art, colored by part.
//
//   node scripts/logo-art.mjs [--cols 28] [--preview] [--map] [--html file]
//
// Writes src/ui/logo-art.ts. Run it again only when the logo or the colors change; the output
// is committed. No dependencies: the PNG is decoded with node:zlib (8-bit RGB/RGBA).
//
// Every dark pixel of the figure is a dot. The figure is split into parts, found from its
// shape rather than fixed coordinates:
// - hat: everything down to the bottom of the brim (the widest row in the top part). The
//   crown, the band just above the brim, and the brim get their own colors.
// - glasses: the dark band right under the brim, where the face shows on both sides.
// - face: the remaining dark parts of the head (side of the head, nose, mouth).
// - tie: thin dark lines inside the shirt (the largest light area below the shoulders).
// - suit: the rest of the body.
// --map prints the parts as letters; --html writes a dark and a light preview page.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const cols = Number(opt('--cols', 28));
const preview = args.includes('--preview');
const showMap = args.includes('--map');
const htmlOut = opt('--html', null);

/** xterm-256 colors per part. Arrays are gradients, top to bottom. */
const PARTS = {
  crown: [209, 203, 167],
  band: [124],
  brim: [130],
  glasses: [239],
  face: [137],
  tie: [31],
  suit: [214, 208, 202, 166],
};

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      if (depth !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error('only 8-bit RGB/RGBA non-interlaced PNGs are supported');
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, px };
}

const img = decodePng(path.join(root, 'assets', 'pulpfixer.png'));
const isDark = (x, y) => {
  const i = (y * img.width + x) * img.channels;
  if (img.channels === 4 && img.px[i + 3] < 128) return false;
  return 0.299 * img.px[i] + 0.587 * img.px[i + 1] + 0.114 * img.px[i + 2] < 110;
};

// Crop to the figure (plus a little backdrop) as a square.
let minX = img.width;
let minY = img.height;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    if (!isDark(x, y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
}
const side = Math.round(Math.max(maxX - minX, maxY - minY) * 1.08);
const cropX = Math.max(0, Math.min(img.width - side, Math.round((minX + maxX) / 2 - side / 2)));
const cropY = Math.max(0, Math.min(img.height - side, Math.round((minY + maxY) / 2 - side / 2)));

// Braille cells are 2 dots wide and 4 tall; a square picture takes `cols` x `cols / 2` cells.
// The raster has 4x4 pixels per dot, so parts can be found more finely than the dots.
const rows = Math.round(cols / 2);
const DOT = 4;
const W = cols * 2 * DOT;
const H = rows * 4 * DOT;
const dark = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    dark[y * W + x] = isDark(cropX + Math.floor(((x + 0.5) / W) * side), cropY + Math.floor(((y + 0.5) / H) * side)) ? 1 : 0;
  }
}

// Light pixels the backdrop cannot reach (shirt, face, hat swoosh). Small gaps in an outline
// still count as closed: the flood only passes spots at least `seal` pixels from any dark one.
const seal = 3;
const near = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!dark[y * W + x]) continue;
    for (let dy = -seal; dy <= seal; dy++) {
      for (let dx = -seal; dx <= seal; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && yy < H && xx >= 0 && xx < W && dx * dx + dy * dy <= seal * seal) near[yy * W + xx] = 1;
      }
    }
  }
}
const outside = new Uint8Array(W * H);
const queue = [];
const visit = (i) => {
  if (!near[i] && !outside[i]) {
    outside[i] = 1;
    queue.push(i);
  }
};
for (let x = 0; x < W; x++) visit(x), visit((H - 1) * W + x);
for (let y = 0; y < H; y++) visit(y * W), visit(y * W + W - 1);
while (queue.length) {
  const i = queue.pop();
  const x = i % W;
  if (x > 0) visit(i - 1);
  if (x < W - 1) visit(i + 1);
  if (i >= W) visit(i - W);
  if (i < W * (H - 1)) visit(i + W);
}
// Grow the backdrop back over the seal band so it hugs the outline.
for (let pass = 0; pass < seal; pass++) {
  const grow = [];
  for (let i = 0; i < W * H; i++) {
    if (outside[i] || dark[i]) continue;
    const x = i % W;
    if ((x > 0 && outside[i - 1]) || (x < W - 1 && outside[i + 1]) || (i >= W && outside[i - W]) || (i < W * (H - 1) && outside[i + W])) grow.push(i);
  }
  for (const i of grow) outside[i] = 1;
}
const feature = (i) => !dark[i] && !outside[i];

// Horizontal extent of the figure per row.
const span = [];
let top = H;
let bottom = 0;
for (let y = 0; y < H; y++) {
  let l = -1;
  let r = -1;
  for (let x = 0; x < W; x++) {
    if (dark[y * W + x]) {
      if (l === -1) l = x;
      r = x;
    }
  }
  span.push(l === -1 ? 0 : r - l + 1);
  if (l !== -1) {
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
}
const figH = bottom - top + 1;

// The brim is the widest row in the top 45% of the figure.
let brimRow = top;
for (let y = top; y < top + figH * 0.45; y++) if (span[y] > span[brimRow]) brimRow = y;
let brimTop = brimRow;
while (brimTop > top && span[brimTop - 1] >= span[brimRow] * 0.75) brimTop--;
let brimBottom = brimRow;
while (brimBottom < bottom && span[brimBottom + 1] >= span[brimRow] * 0.75) brimBottom++;
// Left edge of the figure per row; the shoulders start where it steps out past the head.
const leftEdge = (y) => {
  for (let x = 0; x < W; x++) if (dark[y * W + x]) return x;
  return W;
};
const headLeft = [];
for (let y = brimBottom + 1; y < brimBottom + 1 + Math.round(figH * 0.12); y++) headLeft.push(leftEdge(y));
headLeft.sort((a, b) => a - b);
const headEdge = headLeft[Math.floor(headLeft.length / 2)];
let shoulders = brimBottom + Math.round(figH * 0.12);
while (shoulders < bottom && leftEdge(shoulders) > headEdge - 1.5 * DOT) shoulders++;

// Light face or shirt on both sides of (x, y) before reaching the backdrop, within `reach`.
const between = (x, y, reach) => {
  const look = (dir) => {
    for (let k = 1; k <= reach; k++) {
      const xx = x + dir * k;
      if (xx < 0 || xx >= W) return false;
      const i = y * W + xx;
      if (feature(i)) return true;
      if (outside[i]) return false;
    }
    return false;
  };
  return look(-1) && look(1);
};

// The glasses are the dark band right under the brim: rows where the head is mostly dark.
let glassesBottom = brimBottom + 1;
const darkShare = (y) => {
  let n = 0;
  for (let x = 0; x < W; x++) n += dark[y * W + x];
  return n / (span[y] || 1);
};
while (glassesBottom < shoulders && darkShare(glassesBottom) > 0.55) glassesBottom++;
glassesBottom = Math.min(shoulders, glassesBottom + DOT);
const bandTop = brimTop - Math.max(DOT, Math.round((brimTop - top) * 0.2));

// The shirt is the largest light area below the shoulders. The tie is the thin dark lines
// within its columns; the coat halves next to it are wide.
const shirt = new Uint8Array(W * H);
{
  const seen = new Uint8Array(W * H);
  let best = [];
  for (let start = shoulders * W; start < W * H; start++) {
    if (seen[start] || !feature(start)) continue;
    const comp = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j >= shoulders * W && j < W * H && !seen[j] && feature(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  for (const i of best) shirt[i] = 1;
}
const shirtRange = [];
for (let y = 0; y < H; y++) {
  let l = -1;
  let r = -1;
  for (let x = 0; x < W; x++) {
    if (shirt[y * W + x]) {
      if (l === -1) l = x;
      r = x;
    }
  }
  shirtRange.push(l === -1 ? null : [l, r]);
}
const runLength = (x, y) => {
  let l = x;
  let r = x;
  while (l > 0 && dark[y * W + l - 1]) l--;
  while (r < W - 1 && dark[y * W + r + 1]) r++;
  return r - l + 1;
};
const tieMargin = Math.round(1.5 * DOT);
const tieMaxRun = Math.round(W * 0.06);
const isTie = (x, y) => {
  const range = shirtRange[y];
  return Boolean(range) && x >= range[0] - tieMargin && x <= range[1] + tieMargin && runLength(x, y) <= tieMaxRun;
};

/** Part of every dark pixel, with a 0..1 position inside the part for gradients. */
const part = new Array(W * H).fill(null);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!dark[i]) continue;
    if (y < bandTop) part[i] = 'crown';
    else if (y < brimTop) part[i] = 'band';
    else if (y <= brimBottom) part[i] = 'brim';
    else if (y < glassesBottom) part[i] = between(x, y, W) ? 'glasses' : 'face';
    else if (y < shoulders) part[i] = 'face';
    else if (isTie(x, y)) part[i] = 'tie';
    else part[i] = 'suit';
  }
}
const extent = {};
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = part[y * W + x];
    if (!p) continue;
    extent[p] ??= [y, y];
    extent[p][1] = y;
  }
}

const COLORS = [];
const colorIndex = (n) => {
  if (!COLORS.includes(n)) COLORS.push(n);
  return COLORS.indexOf(n);
};
const colorOf = (p, y) => {
  const ramp = PARTS[p];
  const [a, b] = extent[p];
  const t = b > a ? (y - a) / (b - a) : 0;
  return colorIndex(ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))]);
};

const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
const art = [];
const fgs = [];
for (let row = 0; row < rows; row++) {
  let line = '';
  let fgLine = '';
  for (let col = 0; col < cols; col++) {
    let bits = 0;
    const votes = new Map();
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        let hits = 0;
        const x0 = (col * 2 + dx) * DOT;
        const y0 = (row * 4 + dy) * DOT;
        for (let y = y0; y < y0 + DOT; y++) {
          for (let x = x0; x < x0 + DOT; x++) {
            const p = part[y * W + x];
            if (!p) continue;
            hits++;
            // The small parts win ties so the glasses and tie keep their color at the edges.
            const key = colorOf(p, y);
            votes.set(key, (votes.get(key) ?? 0) + (p === 'glasses' || p === 'tie' ? 2 : 1));
          }
        }
        if (hits / (DOT * DOT) > 0.5) bits |= BIT[dy][dx];
      }
    }
    line += String.fromCharCode(0x2800 + bits);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    fgLine += bits && best ? best[0].toString(36) : ' ';
  }
  art.push(line);
  fgs.push(fgLine);
}

if (showMap) {
  const letter = { crown: 'C', band: 'B', brim: 'R', glasses: 'G', face: 'F', tie: 'T', suit: 'S' };
  for (let y = 0; y < H; y += DOT) {
    let s = '';
    for (let x = 0; x < W; x += DOT / 2) {
      const i = (y + DOT / 2) * W + x;
      s += part[i] ? letter[part[i]] : feature(i) ? '.' : ' ';
    }
    console.log(s);
  }
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const list = (rows) => `[\n${rows.map((l) => `  ${q(l)},`).join('\n')}\n]`;
fs.writeFileSync(
  path.join(root, 'src', 'ui', 'logo-art.ts'),
  `// Generated by scripts/logo-art.mjs from assets/pulpfixer.png. Do not edit by hand.

/** One string per terminal row. Every dot that is set is part of the figure. */
export const LOGO_ART: string[] = ${list(art)};

/** Per character, its color as an index into LOGO_COLORS (base 36); space means uncolored. */
export const LOGO_FG: string[] = ${list(fgs)};

/** xterm-256 colors: hat (crown, band, brim), glasses, face, tie and suit. */
export const LOGO_COLORS: number[] = ${JSON.stringify(COLORS)};
`,
);

function paintRow(r, color) {
  let res = '';
  for (let k = 0; k < art[r].length; k++) {
    res += fgs[r][k] === ' ' ? art[r][k] : color(COLORS[parseInt(fgs[r][k], 36)], art[r][k]);
  }
  return res;
}
if (preview) console.log(art.map((_, r) => paintRow(r, (n, ch) => `\x1b[38;5;${n}m${ch}\x1b[0m`)).join('\n'));
if (htmlOut) {
  const cube = [0, 95, 135, 175, 215, 255];
  const rgb = (n) => {
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v},${v},${v})`;
    }
    const v = n - 16;
    return `rgb(${cube[Math.floor(v / 36)]},${cube[Math.floor(v / 6) % 6]},${cube[v % 6]})`;
  };
  const block = art.map((_, r) => paintRow(r, (n, ch) => `<span style="color:${rgb(n)}">${ch}</span>`)).join('\n');
  const panel = (bg) => `<pre style="background:${bg};padding:16px 24px;margin:0;font:18px/1.05 Menlo,monospace">${block}</pre>`;
  fs.writeFileSync(htmlOut, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888;display:flex;gap:12px;padding:12px">${panel('#1e1e1e')}${panel('#ffffff')}</body>`);
}

console.log(`wrote src/ui/logo-art.ts (${cols} columns x ${rows} rows)`);
