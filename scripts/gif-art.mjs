#!/usr/bin/env node
// Browse a GIF as terminal art and save a frame as a JS module.
//
//   node scripts/gif-art.mjs <file.gif> [--cols N] [--frame middle|first|last|<n>] [--keep-bg]
//                            [--tolerance 40] [--no-trim] [--flat] [--out art.js]
//
// In a terminal it shows the frame as color art (a quadrant character per 2x2 pixels, true color) and waits:
//   left / right   previous / next frame        up / down   10 frames back / forward
//   home / end     first / last frame           + / -       wider / narrower
//   b              cut the background off on / off            t   trim the empty margins on / off
//   f              flat style (spaces on background colors) on / off
//   enter          save the shown frame as a JS module        q   quit
// Without a terminal, or with --out, it writes the frame and exits.
// The size fits the terminal by default (--cols sets it, + / - change it): the biggest picture that fits.
// The background is cut off when the GIF has none already: the color around the edges is made transparent
// (flood fill from the edges, --tolerance is how far a color may differ), and the margins are trimmed.
// Flat style is what Apple Terminal needs: it draws block characters unevenly. It is picked there by itself.
// The saved module (default <gif name>-<frame>.js next to the GIF) exports ART, the rows with their
// colors as ANSI escapes, and print(); run it with node to see the picture.
// No dependencies; the GIF is decoded by gif.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { compose, parseGif } from './gif.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--cols', '--frame', '--out', '--tolerance'].includes(args[i - 1])));
if (!file) {
  console.error('usage: node scripts/gif-art.mjs <file.gif> [--cols N] [--frame middle|first|last|<n>] [--keep-bg] [--tolerance 40] [--no-trim] [--flat] [--out art.js]');
  process.exit(2);
}

let gif;
try {
  gif = parseGif(fs.readFileSync(file));
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
const count = gif.frames.length;
const startWord = opt('--frame', 'middle');
let index = startWord === 'middle' ? Math.floor(count / 2) : startWord === 'first' ? 0 : startWord === 'last' ? count - 1 : Number(startWord);
if (!Number.isInteger(index) || index < 0 || index >= count) {
  console.error(`error: frame ${startWord} is out of range (the GIF has ${count} frames, 0-${count - 1})`);
  process.exit(1);
}
let cols = opt('--cols') ? Number(opt('--cols')) : null; // null: fit the terminal
let trim = !args.includes('--no-trim');
let cutBg = !args.includes('--keep-bg');
const tolerance = Number(opt('--tolerance', 40));
let flat = args.includes('--flat') || process.env.TERM_PROGRAM === 'Apple_Terminal';

const cache = new Map();
/** Make the background transparent: the color along the edges, flooded in from every edge pixel. */
function cutBackground(px) {
  const { width: W, height: H } = gif;
  let clear = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) clear++;
  if (clear > px.length / 4 / 100) return px; // already has transparency
  const edge = [];
  for (let x = 0; x < W; x++) edge.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) edge.push(y * W, y * W + W - 1);
  // The background is the most common color along the edge (quantized so noise does not split it).
  const keyOf = (e) => [px[e * 4], px[e * 4 + 1], px[e * 4 + 2]].map((v) => v >> 4).join(',');
  const votes = new Map();
  for (const e of edge) votes.set(keyOf(e), (votes.get(keyOf(e)) ?? 0) + 1);
  const topKey = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const members = edge.filter((e) => keyOf(e) === topKey);
  const bg = [0, 1, 2].map((k) => members.reduce((sum, e) => sum + px[e * 4 + k], 0) / members.length);
  const out = px.slice();
  const seen = new Uint8Array(W * H);
  const near = (i) => (out[i * 4] - bg[0]) ** 2 + (out[i * 4 + 1] - bg[1]) ** 2 + (out[i * 4 + 2] - bg[2]) ** 2 <= tolerance * tolerance;
  const stack = [];
  for (const e of edge) if (!seen[e] && near(e)) (seen[e] = 1), stack.push(e);
  while (stack.length) {
    const i = stack.pop();
    out[i * 4 + 3] = 0;
    const x = i % W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < W * (H - 1) ? i + W : -1]) {
      if (j >= 0 && !seen[j] && near(j)) (seen[j] = 1), stack.push(j);
    }
  }
  return out;
}

const frameAt = (n) => {
  if (!cache.has(n)) {
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    const px = compose(gif, n);
    cache.set(n, cutBg ? cutBackground(px) : px);
  }
  return cache.get(n);
};
function reset() {
  cache.clear();
  box = null;
}

/** Pixel rectangle to draw: the whole canvas, or the box around everything not transparent in any frame shown so far. */
let box = null;
function bounds() {
  if (!trim) return { x: 0, y: 0, w: gif.width, h: gif.height };
  if (!box) {
    box = { x0: gif.width, y0: gif.height, x1: -1, y1: -1 };
    for (const n of new Set([0, Math.floor(count / 2), count - 1, index])) {
      const px = frameAt(n);
      for (let y = 0; y < gif.height; y++) {
        for (let x = 0; x < gif.width; x++) {
          if (px[(y * gif.width + x) * 4 + 3] < 128) continue;
          box.x0 = Math.min(box.x0, x);
          box.x1 = Math.max(box.x1, x);
          box.y0 = Math.min(box.y0, y);
          box.y1 = Math.max(box.y1, y);
        }
      }
    }
    if (box.x1 < 0) box = { x0: 0, y0: 0, x1: gif.width - 1, y1: gif.height - 1 };
  }
  return { x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 };
}

/** Average color and coverage of the source pixels in each cell of a W x H grid over the rectangle. */
function sample(px, r, W, H) {
  const grid = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x0 = r.x + Math.floor((x / W) * r.w);
      const x1 = Math.max(x0 + 1, r.x + Math.floor(((x + 1) / W) * r.w));
      const y0 = r.y + Math.floor((y / H) * r.h);
      const y1 = Math.max(y0 + 1, r.y + Math.floor(((y + 1) / H) * r.h));
      const sum = [0, 0, 0];
      let weight = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * gif.width + xx) * 4;
          const a = px[i + 3] / 255;
          for (let k = 0; k < 3; k++) sum[k] += px[i + k] * a;
          weight += a;
          n++;
        }
      }
      grid.push({ rgb: weight ? sum.map((v) => v / weight) : [0, 0, 0], alpha: weight / n });
    }
  }
  return grid;
}
const mean = (list) => [0, 1, 2].map((k) => list.reduce((s, c) => s + c[k], 0) / list.length);
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const col = (rgb, base) => `${base};2;${Math.round(rgb[0])};${Math.round(rgb[1])};${Math.round(rgb[2])}`;
const QUADRANT = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';

/** Columns that make the biggest picture fitting the terminal (width and height), or `cols` when set. */
function fit() {
  if (cols) return cols;
  const r = bounds();
  const tw = (process.stdout.columns || 100) - 2;
  const th = (process.stdout.rows || 40) - 6;
  return Math.max(8, Math.min(tw, 160, Math.floor((2 * th * r.w) / r.h)));
}

/** The frame as colored terminal rows (ANSI escapes), `cols` characters wide. */
function art(n) {
  const r = bounds();
  const cols = fit();
  const rows = Math.max(1, Math.round((cols * r.h) / r.w / 2));
  const px = frameAt(n);
  const lines = [];
  if (flat) {
    // Two spaces on a background color per pixel: exact in every terminal, half the detail.
    const W = Math.floor(cols / 2);
    const H = Math.max(1, Math.round((W * r.h) / r.w));
    const g = sample(px, r, W, H);
    for (let y = 0; y < H; y++) {
      let line = '';
      for (let x = 0; x < W; x++) {
        const p = g[y * W + x];
        line += p.alpha >= 0.5 ? `\x1b[48;${col(p.rgb, 0).slice(2)}m  \x1b[0m` : '  ';
      }
      lines.push(line);
    }
    return lines;
  }
  const g = sample(px, r, cols * 2, rows * 2);
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const quad = [0, 1, 2, 3].map((q) => g[(row * 2 + (q >> 1)) * cols * 2 + c * 2 + (q & 1)]);
      const solid = quad.map((p) => p.alpha >= 0.5);
      if (solid.every((s) => !s)) {
        line += ' ';
        continue;
      }
      let mask;
      let fg;
      let bg = null;
      if (solid.some((s) => !s)) {
        mask = solid.reduce((m, s, q) => (s ? m | (1 << q) : m), 0);
        fg = mean(quad.filter((_, q) => solid[q]).map((p) => p.rgb));
      } else {
        let bestErr = Infinity;
        for (let m = 1; m < 16; m++) {
          const on = quad.filter((_, q) => m & (1 << q)).map((p) => p.rgb);
          const off = quad.filter((_, q) => !(m & (1 << q))).map((p) => p.rgb);
          const f = mean(on);
          const b = off.length ? mean(off) : null;
          const e = on.reduce((s, c2) => s + dist(c2, f), 0) + (b ? off.reduce((s, c2) => s + dist(c2, b), 0) : 0);
          if (e < bestErr) [bestErr, mask, fg, bg] = [e, m, f, b];
        }
      }
      line += `\x1b[0;${col(fg, 38)}${bg ? `;${col(bg, 48)}` : ''}m${QUADRANT[mask]}\x1b[0m`;
    }
    lines.push(line);
  }
  return lines;
}

const base = path.basename(file, path.extname(file));
const defaultOut = (n) => path.join(path.dirname(file), `${base}-${n}.js`);

/** Write the frame as an ES module. */
function save(n, dest) {
  const lines = art(n);
  const js = `// Generated by scripts/gif-art.mjs from ${path.basename(file)}, frame ${n} of ${count} (${fit()} columns, ${flat ? 'flat' : 'quadrant'} style).
// Each row is a string with its colors as ANSI true-color escapes. Run this file with node to see it.

export const ART = [
${lines.map((l) => `  ${JSON.stringify(l)},`).join('\n')}
];

export function print(out = process.stdout) {
  out.write(\`\${ART.join('\\n')}\\n\`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) print();
`;
  fs.writeFileSync(dest, js);
  return dest;
}

const out = opt('--out');
if (out || !process.stdin.isTTY || !process.stdout.isTTY) {
  const dest = save(index, out ?? defaultOut(index));
  if (!out) process.stdout.write(art(index).join('\n') + '\n');
  console.error(`wrote ${dest} (frame ${index} of ${count})`);
  process.exit(0);
}

// Interactive viewer.
let note = '';
function draw() {
  const lines = art(index);
  const status = `frame ${index + 1}/${count}  ${fit()} cols  ${flat ? 'flat' : 'quadrant'}${trim ? '  trimmed' : ''}${cutBg ? '  bg cut' : ''}`;
  const keys = '\x1b[2m←/→ frame  ↑/↓ ±10  home/end  +/- size  b background  t trim  f flat  enter save  q quit\x1b[0m';
  process.stdout.write(`\x1b[H\x1b[J${lines.join('\n')}\n\n${status}\n${keys}\n${note ? `${note}\n` : ''}`);
  note = '';
}
function quit(code = 0) {
  process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.exit(code);
}
process.stdout.write('\x1b[?1049h\x1b[?25l');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
const KEYS = { '\x1b[C': 1, '\x1b[D': -1, '\x1b[A': -10, '\x1b[B': 10 };
// Keys that arrive together (held arrow, fast typing) come in one chunk: handle them one by one.
process.stdin.on('data', (chunk) => {
  let changed = false;
  for (const k of chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) changed = press(k) || changed;
  if (changed) draw();
});
function press(k) {
  if (k === 'q' || k === '\x03' || k === '\x1b') return quit();
  if (k in KEYS) {
    // Up goes back, down goes forward, like scrolling a timeline.
    index = Math.min(count - 1, Math.max(0, index + KEYS[k]));
  } else if (k === '\x1b[H' || k === '\x1b[1~') index = 0;
  else if (k === '\x1b[F' || k === '\x1b[4~') index = count - 1;
  else if (k === '+' || k === '=') cols = Math.min(160, fit() + 4);
  else if (k === '-') cols = Math.max(8, fit() - 4);
  else if (k === 't') trim = !trim;
  else if (k === 'b') (cutBg = !cutBg), reset();
  else if (k === 'f') flat = !flat;
  else if (k === '\r' || k === '\n') note = `\x1b[32msaved ${save(index, defaultOut(index))}\x1b[0m`;
  else return false;
  return true;
}
process.on('SIGWINCH', draw);
draw();
