#!/usr/bin/env node
// Pull one frame out of a GIF and save it as a PNG (with transparency kept), as the source picture
// for scripts/travolta-art.mjs style art generators.
//
//   node scripts/gif-frame.mjs <file.gif> [--frame middle|first|last|<n>] [--out frame.png]
//                              [--crop x,y,w,h] [--info]
//
// --frame  which frame (0-based number, or middle / first / last); default middle
// --out    where to write the PNG; default <gif name>-<frame>.png next to the GIF
// --crop   keep only this rectangle (pixels), e.g. to cut away empty margins
// --info   print the size and frame count and exit
// No dependencies: the GIF is decoded here (LZW, interlacing, disposal, transparency) and the PNG
// is encoded with node:zlib.

import fs from 'node:fs';
import path from 'node:path';
import { compose, encodePng, parseGif } from './gif.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--frame', '--out', '--crop'].includes(args[i - 1])));
if (!file) {
  console.error('usage: node scripts/gif-frame.mjs <file.gif> [--frame middle|first|last|<n>] [--out frame.png] [--crop x,y,w,h] [--info]');
  process.exit(2);
}

try {
  const gif = parseGif(fs.readFileSync(file));
  const n = gif.frames.length;
  const ms = gif.frames.reduce((s, f) => s + f.delay * 10, 0);
  if (args.includes('--info')) {
    console.log(`${path.basename(file)}: ${gif.width}x${gif.height}, ${n} frames, ${ms} ms`);
    process.exit(0);
  }
  const want = opt('--frame', 'middle');
  const index = want === 'middle' ? Math.floor(n / 2) : want === 'first' ? 0 : want === 'last' ? n - 1 : Number(want);
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new Error(`frame ${want} is out of range (the GIF has ${n} frames, 0-${n - 1})`);
  let px = compose(gif, index);
  let [w, h] = [gif.width, gif.height];
  const crop = opt('--crop');
  if (crop) {
    const [cx, cy, cw, ch] = crop.split(',').map(Number);
    if ([cx, cy, cw, ch].some((v) => !Number.isInteger(v) || v < 0) || !cw || !ch || cx + cw > w || cy + ch > h) throw new Error(`--crop ${crop} does not fit in ${w}x${h}`);
    const out = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) out.set(px.subarray(((cy + y) * w + cx) * 4, ((cy + y) * w + cx + cw) * 4), y * cw * 4);
    [px, w, h] = [out, cw, ch];
  }
  const dest = opt('--out', path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-${index}.png`));
  fs.writeFileSync(dest, encodePng(px, w, h));
  console.log(`wrote ${dest} (frame ${index} of ${n}, ${w}x${h})`);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
