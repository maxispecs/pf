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

/**
 * The program name as a standalone word: `pf` in `pf update` or `(pf)`, but not a path or
 * file (`./pf`, `~/.pf/skills`, `pf.json`), a package (`@pf-plugins`) or an identifier (`pf_x`).
 * An already painted `pf` is skipped because an escape code's `m` sits right before it.
 */
const PF_WORD = /(?<![\w./~@-])pf(?![\w/-]|\.\w)/g;
const PF_COLOR = '\x1b[1;31m';

/**
 * Paint every standalone `pf` in `s` bold red, then restore `reopen` (the escape code of the
 * surrounding style) so the rest of the text keeps its color. Plain text when color is off.
 */
export function redPf(s: string, reopen = '', on: boolean = colorEnabled(process.stdout)): string {
  return on ? String(s).replace(PF_WORD, `${PF_COLOR}pf\x1b[0m${reopen}`) : String(s);
}

export function palette(stream: NodeJS.WriteStream = process.stdout): Palette {
  const on = colorEnabled(stream);
  // Every style paints a standalone `pf` bold red, whatever the surrounding color is.
  const paint = (code: string, keepPf = false) => (s: string) => {
    if (!on) return String(s);
    const open = `\x1b[${code}m`;
    return `${open}${keepPf ? s : redPf(s, open, true)}\x1b[0m`;
  };
  return {
    on,
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31', true),
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
