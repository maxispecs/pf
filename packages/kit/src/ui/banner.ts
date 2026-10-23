import { LOGO_ART, LOGO_COLORS, LOGO_FG } from './logo-art.js';
import { err, fitLine, stripAnsi, type Palette } from './palette.js';
import { displayVersion } from '../version.js';
import { compareVersions } from '../util.js';

export interface BannerInfo {
  version: string;
  /** Repo name, when inside a repo. */
  repo?: string;
  /** Detected stack labels. */
  stacks?: string[];
  /** Newer version known from the cached update check. */
  latest?: string;
  /** Running from a checkout via ./pf rather than the installed binary. */
  local?: boolean;
}

/** The one-line banner every pf invocation prints. Goes to stderr so stdout stays pipeable. */
export function renderBanner(info: BannerInfo, c = err()): string {
  const parts = [`${c.boldBrand('pf')} ${c.bold('v' + displayVersion(info.version))}${info.local ? ' ' + c.yellow('(local)') : ''}`];
  if (info.repo) {
    const stacks = info.stacks?.length ? `  ${c.dim(info.stacks.join(', '))}` : '';
    parts.push(`${c.cyan(info.repo)}${stacks}`);
  }
  let line = parts.join(c.dim('  ·  '));
  if (info.latest && compareVersions(info.latest, info.version) > 0) {
    line += `  ${c.yellow('↑ v' + displayVersion(info.latest) + ' available, run pf update')}`;
  }
  return line;
}

/** Orange gradient (256-color palette) for the rule under the name. */
const GRADIENT = [221, 215, 214, 208, 202, 166];
const GAP = '   ';
const MOTTO = 'the wolf of dev street';
const MOTTO_GRAY = 245;
/** Width of the gradient rule under the name. */
const RULE_WIDTH = 37;
/** Row of the art where the text beside it starts (the text block is centered on the figure). */
const TEXT_TOP = 4;

/** Narrowest terminal the full logo fits in. */
export const LOGO_MIN_COLS = 2 + LOGO_ART[0]!.length + GAP.length + RULE_WIDTH + 4;
/** Fewest terminal rows worth spending on the logo; shorter windows get the one-line banner. */
export const LOGO_MIN_ROWS = 28;

/** Whether the big header fits the terminal. A missing size counts as too small. */
export function logoFits(cols: number | undefined, rows: number = Infinity): boolean {
  return (cols ?? 0) >= LOGO_MIN_COLS && rows >= LOGO_MIN_ROWS;
}

/** One row of the logo in color. Runs of the same color share one escape sequence. */
function paintLogoRow(i: number, c: Palette): string {
  const chars = [...LOGO_ART[i]!];
  let res = '';
  let run = '';
  let runColor: number | undefined;
  const flush = () => {
    if (run) res += runColor === undefined ? run : c.fg(runColor, run);
    run = '';
  };
  chars.forEach((ch, k) => {
    const code = LOGO_FG[i]![k];
    const color = code && code !== ' ' ? LOGO_COLORS[parseInt(code, 36)] : undefined;
    if (color !== runColor) {
      flush();
      runColor = color;
    }
    run += ch;
  });
  flush();
  return res;
}

/**
 * The large header: the logo (the detective in braille dots, colored by part) on the left,
 * name, motto and the versioned info line on the right. It always contains
 * `pf v<version>` so the banner invariant holds.
 */
export function renderLogo(info: BannerInfo, c: Palette = err(), cols = 80): string {
  const side: string[] = [];
  side[0] = `${c.boldBrand('p u l p f i x e r')}`;
  side[1] = c.fg(MOTTO_GRAY, MOTTO);
  const rule = '░▒▓' + '█'.repeat(RULE_WIDTH - 6) + '▓▒░';
  side[2] = [...rule].map((ch, i) => c.fg(GRADIENT[Math.min(GRADIENT.length - 1, Math.floor((i / rule.length) * GRADIENT.length))]!, ch)).join('');
  // The one-line banner appends the update hint; here the hint gets its own row below.
  const { latest, ...withoutLatest } = info;
  side[3] = renderBanner(withoutLatest, c);
  if (latest && compareVersions(latest, info.version) > 0) {
    side[4] = c.yellow('↑ v' + displayVersion(latest) + ' available, run pf update');
  }
  const art = LOGO_ART.map((_, i) => paintLogoRow(i, c));
  const rows = art.map((row, i) => fitLine(`  ${row}${GAP}${side[i - TEXT_TOP] ?? ''}`, cols));
  return ['', ...rows, ''].join('\n');
}

export interface PrintOptions {
  /** Use the big logo when the terminal is a wide-enough TTY. */
  logo?: boolean;
}

export function printBanner(info: BannerInfo, opts: PrintOptions = {}): void {
  const cols = process.stderr.columns;
  if (opts.logo && process.stderr.isTTY && logoFits(cols, process.stderr.rows)) {
    process.stderr.write(renderLogo(info, err(), cols) + '\n');
    return;
  }
  process.stderr.write(renderBanner(info) + '\n');
}

/** Plain width of a rendered block (for tests). */
export function blockWidth(block: string): number {
  return Math.max(0, ...block.split('\n').map((l) => stripAnsi(l).length));
}
