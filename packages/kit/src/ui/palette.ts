export function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== '0';
  return Boolean(stream.isTTY) && process.env.TERM !== 'dumb';
}

export interface Palette {
  on: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
  /** Brand color (pulp orange). */
  brand(s: string): string;
  boldBrand(s: string): string;
  /** Selected-row highlight. */
  inverse(s: string): string;
  /** Any of the 256 terminal colors (used for the logo gradient). */
  fg(n: number, s: string): string;
}

export function palette(stream: NodeJS.WriteStream = process.stdout): Palette {
  const on = colorEnabled(stream);
  const paint = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    on,
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31'),
    green: paint('32'),
    yellow: paint('33'),
    blue: paint('34'),
    magenta: paint('35'),
    cyan: paint('36'),
    brand: paint('38;5;208'),
    boldBrand: paint('1;38;5;208'),
    inverse: paint('7'),
    fg: (n, s) => (on ? `\x1b[38;5;${n}m${s}\x1b[0m` : String(s)),
  };
}

export const out = (): Palette => palette(process.stdout);
export const err = (): Palette => palette(process.stderr);

/** Strip ANSI escapes (for width math and tests). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Cut a line to `cols` visible characters, keeping escape sequences intact. Adds an ellipsis
 * when something was cut. Lines wider than the terminal wrap and break cursor-up redraws.
 */
export function fitLine(s: string, cols: number): string {
  if (cols <= 1 || stripAnsi(s).length <= cols) return s;
  let visible = 0;
  let res = '';
  for (let i = 0; i < s.length; ) {
    // eslint-disable-next-line no-control-regex
    const esc = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (esc) {
      res += esc[0];
      i += esc[0].length;
      continue;
    }
    if (visible >= cols - 1) break;
    res += s[i];
    visible++;
    i++;
  }
  return `${res}${res.includes('\x1b') ? '\x1b[0m' : ''}…`;
}
