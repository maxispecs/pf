import { err, type Palette } from './palette.js';
import { halfBlocks, sgr, trueColor } from './lost.js';

/** The small octopus that decorates a few commands: original pixel art, one picture per command. */
export type MascotName = 'repo' | 'update' | 'agent';

const COLORS: Record<string, string> = {
  o: 'f08a30', // body
  w: 'f7f7f2', // eye white
  k: '2a2230', // pupil, mouth
  c: '49d2e8', // robot eyes
  r: 'e5484d', // antenna light
  g: '3fb950', // arrow
  y: 'f2c14e', // folder
  Y: 'd9a42f', // folder shade
};

const W = 24;
const TOP = 6;

/** The octopus under the accessory. Eyes are `w`; the agent swaps them for `c`. */
const BODY = [
  '........oooooooo........',
  '......oooooooooooo......',
  '....oooooooooooooooo....',
  '...oooooooooooooooooo...',
  '...oooWWWooooooWWWooo...',
  '...oooWkWooooooWkWooo...',
  '...oooWWWooooooWWWooo...',
  '...oooooooookkoooooooo..',
  '....oooooooooooooooo....',
  '..ooo..ooo....ooo..ooo..',
  '.ooo..ooo......ooo..ooo.',
  'ooo..ooo........ooo..ooo',
  'oo...oo..........oo...oo',
];

/** What sits above the head, 6 pixels wide, bottom aligned. */
const ACCESSORY: Record<MascotName, string[]> = {
  repo: ['yyy...', 'yyyyyy', 'yYYYYy', 'yyyyyy', 'yyyyyy'],
  update: ['..gg..', '.gggg.', 'gggggg', '..gg..', '..gg..', '..gg..'],
  agent: ['..rr..', '..rr..', '..kk..', '..kk..'],
};

/** The picture as pixel rows (`.` is transparent), made even in height so it fills whole terminal rows. */
export function mascotPixels(name: MascotName): string[] {
  const acc = ACCESSORY[name];
  const left = (W - 6) / 2;
  const rows: string[] = [];
  for (let y = 0; y < TOP; y++) {
    const a = acc[y - (TOP - acc.length)];
    rows.push(a ? '.'.repeat(left) + a + '.'.repeat(left) : '.'.repeat(W));
  }
  for (const row of BODY) rows.push(row.replace(/W/g, name === 'agent' ? 'c' : 'w'));
  if (rows.length % 2) rows.push('.'.repeat(W));
  return rows;
}

const rgb = (hex: string): number[] => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexOf = (px: number[]) => px.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mean = (list: number[][]) => [0, 1, 2].map((k) => list.reduce((s, c) => s + c[k]!, 0) / list.length);
const dist = (a: number[], b: number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
const ones = (m: number) => [0, 1, 2, 3].filter((q) => m & (1 << q)).length;
const QUADRANT = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';

/** One cell from a 2x2 block of pixels (upper left, upper right, lower left, lower right; null is see-through). */
function cell(quad: (number[] | null)[]): { ch: string; fg?: string; bg?: string } {
  const solid = quad.filter((p): p is number[] => p !== null);
  if (!solid.length) return { ch: ' ' };
  if (solid.length < 4) {
    const want = quad.reduce((m, p, q) => (p ? m | (1 << q) : m), 0);
    let mask = 15;
    for (let m = 1; m < 16; m++) if (ones(m ^ want) < ones(mask ^ want)) mask = m;
    return { ch: QUADRANT[mask]!, fg: hexOf(mean(solid)) };
  }
  let best = { mask: 15, err: Infinity, fg: solid[0]!, bg: null as number[] | null };
  for (let mask = 1; mask < 16; mask++) {
    const on = quad.filter((_, q) => mask & (1 << q)) as number[][];
    const off = quad.filter((_, q) => !(mask & (1 << q))) as number[][];
    const fg = mean(on);
    const bg = off.length ? mean(off) : null;
    const e = on.reduce((s, p) => s + dist(p, fg), 0) + (bg ? off.reduce((s, p) => s + dist(p, bg), 0) : 0);
    if (e < best.err) best = { mask, err: e, fg, bg };
  }
  return { ch: QUADRANT[best.mask]!, fg: hexOf(best.fg), ...(best.bg ? { bg: hexOf(best.bg) } : {}) };
}

/** Width in characters and height in rows of the picture, for the quadrant and the flat version. */
export function mascotSize(flat: boolean): { width: number; height: number } {
  const rows = mascotPixels('repo').length;
  return flat ? { width: W * 2, height: rows } : { width: W / 2, height: rows / 2 };
}

/**
 * The picture for a command, in color only (it is decoration, so there is no plain version).
 * Quadrant characters by default; flat (two spaces on a background color per pixel) where the
 * terminal draws block characters unevenly, same as Travolta.
 */
export function renderMascot(name: MascotName, c: Palette = err(), full = trueColor(), flat = halfBlocks()): string {
  if (!c.on) return '';
  const px = mascotPixels(name).map((row) => [...row].map((ch) => (COLORS[ch] ? rgb(COLORS[ch]!) : null)));
  const lines: string[] = [];
  if (flat) {
    for (const row of px) {
      let res = '';
      for (const p of row) res += p ? `\x1b[${sgr(hexOf(p), 48, full)}m  \x1b[0m` : '  ';
      lines.push(res);
    }
  } else {
    for (let y = 0; y < px.length; y += 2) {
      let res = '';
      for (let x = 0; x < W; x += 2) {
        const { ch, fg, bg } = cell([px[y]![x]!, px[y]![x + 1]!, px[y + 1]![x]!, px[y + 1]![x + 1]!]);
        res += ch === ' ' ? ' ' : `\x1b[${['0', ...(fg ? [sgr(fg, 38, full)] : []), ...(bg ? [sgr(bg, 48, full)] : [])].join(';')}m${ch}\x1b[0m`;
      }
      lines.push(res);
    }
  }
  return ['', ...lines.map((l) => `  ${l}`)].join('\n');
}

/** Print the picture to stderr, only on a color terminal big enough for it (never into logs or pipes). */
export function printMascot(name: MascotName): void {
  if (process.env.PF_NO_TRAVOLTA || process.env.PF_NO_MASCOT || !process.stderr.isTTY) return;
  const { width, height } = mascotSize(halfBlocks());
  if ((process.stderr.columns ?? 0) < width + 2 || (process.stderr.rows ?? 0) < height + 6) return;
  const art = renderMascot(name);
  if (art) process.stderr.write(art + '\n');
}
