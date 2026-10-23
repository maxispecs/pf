#!/usr/bin/env node
// Turn scripts/art/travolta.png into the art pf shows when it is lost: an unknown command or an error.
// The PNG is frame 112 of the confused-Travolta cutout GIF (transparent background), cropped just below the hands.
//
//   node scripts/travolta-art.mjs [--cols 52] [--preview]
//
// Writes packages/kit/src/ui/travolta-art.ts. The output is committed; run it again only to change the look.
// Two versions of the same picture, `cols` characters wide:
// - color: every character is a 2x2 block of pixels drawn with a quadrant character (▘▝▀▖▌▞▛▗▚▐▜▄▙▟█)
//   in two colors, the split that keeps each half closest to its pixels. Colors are stored as RGB and
//   mapped to true color or xterm-256 when drawn. Transparent pixels show the terminal's background.
// - braille dots for terminals without color: the dark parts (suit, hair) plus the edges.
// No dependencies: the PNG is decoded with node:zlib.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const cols = Number(opt('--cols', 52));
const preview = args.includes('--preview');

/** Below this luminance a braille dot is set; edges stronger than EDGE are set too. */
const DARK = 70;
const EDGE = 260;

const img = decodePng(path.join(root, 'scripts', 'art', 'travolta.png'));
// A terminal cell is about twice as tall as wide.
const rows = Math.round((cols * img.height) / img.width / 2);

/** Average color and coverage (0..1) of the source pixels in each cell of a W x H grid. */
function sample(W, H) {
  const grid = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x / W) * img.width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) / W) * img.width));
      const y0 = Math.floor((y / H) * img.height);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) / H) * img.height));
      const sum = [0, 0, 0];
      let weight = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * img.channels;
          const a = img.channels === 4 ? img.px[i + 3] / 255 : 1;
          for (let k = 0; k < 3; k++) sum[k] += img.px[i + k] * a;
          weight += a;
          n++;
        }
      }
      grid.push({ rgb: weight ? sum.map((v) => v / weight) : [0, 0, 0], alpha: weight / n });
    }
  }
  return grid;
}
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const mean = (list) => [0, 1, 2].map((k) => list.reduce((s, c) => s + c[k], 0) / list.length);
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const hex = (rgb) => rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Color: quadrant bits are 1 upper left, 2 upper right, 4 lower left, 8 lower right.
const QUADRANT = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
const px = sample(cols * 2, rows * 2);
// Terminals that draw block glyphs unevenly (Apple Terminal) get a flat version: spaces on background colors.
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const bits = (m) => [0, 1, 2, 3].filter((q) => m & (1 << q)).length;
function paint(masks, flat = false) {
  const chars = [];
  const fgs = [];
  const bgs = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    let fgLine = '';
    let bgLine = '';
    for (let col = 0; col < cols; col++) {
      const quad = [0, 1, 2, 3].map((q) => px[(row * 2 + (q >> 1)) * cols * 2 + col * 2 + (q & 1)]);
      const solid = quad.map((p) => p.alpha >= 0.5);
      let best = { mask: 0, fg: null, bg: null };
      if (flat) {
        // One color per cell, drawn as a space on a background color: exact in every terminal.
        const on = quad.filter((_, q) => solid[q]);
        if (on.length >= 2) best = { mask: 0, fg: null, bg: mean(on.map((p) => p.rgb)) };
      } else if (solid.every((s) => !s)) {
        // Nothing here: the terminal's own background.
      } else if (solid.some((s) => !s)) {
        // At the outline the see-through pixels are the background half.
        const want = solid.reduce((m, s, q) => (s ? m | (1 << q) : m), 0);
        const mask = masks.reduce((b, m) => (bits(m ^ want) < bits(b ^ want) ? m : b), masks[0]);
        best = { mask, fg: mean(quad.filter((_, q) => solid[q]).map((p) => p.rgb)), bg: null };
      } else {
        let bestErr = Infinity;
        for (const mask of masks) {
          const on = quad.filter((_, q) => mask & (1 << q)).map((p) => p.rgb);
          const off = quad.filter((_, q) => !(mask & (1 << q))).map((p) => p.rgb);
          const fg = mean(on);
          const bg = off.length ? mean(off) : fg;
          const e = on.reduce((s, c) => s + dist(c, fg), 0) + off.reduce((s, c) => s + dist(c, bg), 0);
          if (e < bestErr) {
            bestErr = e;
            best = { mask, fg, bg: off.length ? bg : null };
          }
        }
      }
      line += QUADRANT[best.mask];
      fgLine += best.fg ? hex(best.fg) : '------';
      bgLine += best.bg ? hex(best.bg) : '------';
    }
    chars.push(line);
    fgs.push(fgLine);
    bgs.push(bgLine);
  }
  return { chars, fgs, bgs };
}
const { chars, fgs, bgs } = paint(ALL);
const half = paint(ALL, true);

// Braille: cells are 2 dots wide and 4 tall.
const W = cols * 2;
const H = rows * 4;
const dotPx = sample(W, H);
const L = dotPx.map((p) => (p.alpha < 0.5 ? 255 : lum(p.rgb)));
const at = (x, y) => L[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
const dot = (x, y) => {
  const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
  const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
  return at(x, y) < DARK || Math.hypot(gx, gy) > EDGE;
};
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
const dots = [];
for (let row = 0; row < rows; row++) {
  let line = '';
  for (let col = 0; col < cols; col++) {
    let bits = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) if (dot(col * 2 + dx, row * 4 + dy)) bits |= BIT[dy][dx];
    line += String.fromCharCode(0x2800 + bits);
  }
  dots.push(line);
}

const list = (lines) => `[\n${lines.map((l) => `  '${l}',`).join('\n')}\n]`;
fs.writeFileSync(
  path.join(root, 'packages', 'kit', 'src', 'ui', 'travolta-art.ts'),
  `// Generated by scripts/travolta-art.mjs from scripts/art/travolta.png. Do not edit by hand.

/** The color picture: one quadrant character per cell, one string per terminal row. */
export const TRAVOLTA_CHARS: string[] = ${list(chars)};

/** The same picture as spaces on background colors, for terminals that draw block characters unevenly. */
export const TRAVOLTA_HALF_CHARS: string[] = ${list(half.chars)};
export const TRAVOLTA_HALF_FG: string[] = ${list(half.fgs)};
export const TRAVOLTA_HALF_BG: string[] = ${list(half.bgs)};

/** Per cell, the foreground as 6 hex digits (RGB); ------ means none. */
export const TRAVOLTA_FG: string[] = ${list(fgs)};

/** Per cell, the background as 6 hex digits (RGB); ------ means the terminal's own. */
export const TRAVOLTA_BG: string[] = ${list(bgs)};

/** The same picture in braille dots, for terminals without color. One string per terminal row. */
export const TRAVOLTA_DOTS: string[] = ${list(dots)};
`,
);

if (preview) {
  const sgr = (h, base) => (h === '------' ? '' : `\x1b[${base};2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}m`);
  for (let r = 0; r < rows; r++) {
    let s = '';
    for (let x = 0; x < cols; x++) s += `${sgr(fgs[r].slice(x * 6, x * 6 + 6), 38)}${sgr(bgs[r].slice(x * 6, x * 6 + 6), 48)}${chars[r][x]}\x1b[0m`;
    console.log(`${s}  ${dots[r]}`);
  }
}
console.log(`wrote packages/kit/src/ui/travolta-art.ts (${cols} columns x ${rows} rows)`);
