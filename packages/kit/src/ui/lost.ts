import {
  TRAVOLTA_BG,
  TRAVOLTA_CHARS,
  TRAVOLTA_DOTS,
  TRAVOLTA_FG,
  TRAVOLTA_HALF_BG,
  TRAVOLTA_HALF_CHARS,
  TRAVOLTA_HALF_FG,
} from './travolta-art.js';
import { err, type Palette } from './palette.js';

/** Width of the picture in characters. */
export const LOST_WIDTH = TRAVOLTA_DOTS[0]!.length;
/** Terminal rows the picture takes, including the blank line above it. */
export const LOST_HEIGHT = TRAVOLTA_DOTS.length + 1;
/** Fewest terminal rows that get Travolta (he may scroll off the top); only very short windows (10 rows or less) skip him. */
export const LOST_MIN_ROWS = 11;

/** Whether the terminal takes 24-bit colors (COLORTERM is how terminals say so). */
export function trueColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return /truecolor|24bit/i.test(env.COLORTERM ?? '');
}

// Nearest xterm-256 color: the 6x6x6 cube, or the gray ramp for colors that are nearly gray
// (the cube is too coarse for them and turns grays pink or green).
const CUBE = [0, 95, 135, 175, 215, 255];
const nearestCube = (v: number) => CUBE.reduce((best, c, k) => (Math.abs(c - v) < Math.abs(CUBE[best]! - v) ? k : best), 0);
export function xterm256(r: number, g: number, b: number): number {
  const k = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + k * 10;
  const [cr, cg, cb] = [nearestCube(r), nearestCube(g), nearestCube(b)];
  const cubeDist = (CUBE[cr]! - r) ** 2 + (CUBE[cg]! - g) ** 2 + (CUBE[cb]! - b) ** 2;
  const grayDist = (gray - r) ** 2 + (gray - g) ** 2 + (gray - b) ** 2;
  return Math.max(r, g, b) - Math.min(r, g, b) < 18 || grayDist < cubeDist ? 232 + k : 16 + 36 * cr + 6 * cg + cb;
}

/**
 * Whether to draw flat (spaces on background colors, no block characters). Apple Terminal draws block
 * characters unevenly (gaps and offsets), so the picture comes out jagged. `PF_TRAVOLTA_BLOCKS=half|quadrant` overrides.
 */
export function halfBlocks(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.PF_TRAVOLTA_BLOCKS;
  return forced ? forced === 'half' : env.TERM_PROGRAM === 'Apple_Terminal';
}

/** SGR parameters for a stored color (`rrggbb`), as foreground (38) or background (48). */
function sgr(hex: string, base: 38 | 48, full: boolean): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return full ? `${base};2;${r};${g};${b}` : `${base};5;${xterm256(r, g, b)}`;
}

/** One terminal row in color. Cells with the same colors share one escape sequence. */
function paintRow(i: number, full: boolean, half: boolean): string {
  const [CHARS, FG, BG] = half ? [TRAVOLTA_HALF_CHARS, TRAVOLTA_HALF_FG, TRAVOLTA_HALF_BG] : [TRAVOLTA_CHARS, TRAVOLTA_FG, TRAVOLTA_BG];
  const chars = CHARS[i]!;
  let res = '';
  let last = '';
  for (let x = 0; x < chars.length; x++) {
    const fg = FG[i]!.slice(x * 6, x * 6 + 6);
    const bg = BG[i]!.slice(x * 6, x * 6 + 6);
    const codes = ['0', ...(fg === '------' ? [] : [sgr(fg, 38, full)]), ...(bg === '------' ? [] : [sgr(bg, 48, full)])].join(';');
    if (codes !== last) res += `\x1b[${codes}m`;
    res += chars[x];
    last = codes;
  }
  return `${res}\x1b[0m`;
}

/**
 * Confused Travolta, for when pf is lost (an unknown command, an error). In color he is a picture
 * (true color when the terminal says it takes it, else 256 colors); without color he is braille dots.
 */
export function renderLost(c: Palette = err(), full = trueColor(), half = halfBlocks()): string {
  const rows = c.on ? TRAVOLTA_CHARS.map((_, i) => paintRow(i, full, half)) : TRAVOLTA_DOTS;
  return ['', ...rows.map((row) => `  ${row}`)].join('\n');
}

/** Whether Travolta fits the terminal. A missing size counts as too small. */
export function lostFits(cols: number | undefined, rows: number | undefined): boolean {
  return (cols ?? 0) >= LOST_WIDTH + 2 && (rows ?? 0) >= LOST_MIN_ROWS;
}

/** Print Travolta to stderr, only on a terminal big enough for him (never into logs or pipes). */
export function printLost(): void {
  if (process.env.PF_NO_TRAVOLTA || !process.stderr.isTTY || !lostFits(process.stderr.columns, process.stderr.rows)) return;
  process.stderr.write(renderLost() + '\n');
}
