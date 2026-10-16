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
}

/** The one-line banner every pf invocation prints. Goes to stderr so stdout stays pipeable. */
export function renderBanner(info: BannerInfo, c = err()): string {
  const parts = [`${c.boldBrand('pf')} ${c.bold('v' + displayVersion(info.version))}`];
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

/** Block-letter "pf". The shadow glyphs are drawn in a darker tone than the solid blocks. */
const LOGO = [
  '██████╗ ███████╗',
  '██╔══██╗██╔════╝',
  '██████╔╝█████╗  ',
  '██╔═══╝ ██╔══╝  ',
  '██║     ██║     ',
  '╚═╝     ╚═╝     ',
];

/** Top-to-bottom orange gradient (256-color palette), gold to deep orange. */
const GRADIENT = [221, 215, 214, 208, 202, 166];
const SHADOW = 130;
const GAP = '   ';
const TAGLINE = 'one CLI for every repo, in any language';

/** Narrowest terminal the full logo fits in. */
export const LOGO_MIN_COLS = LOGO[0]!.length + GAP.length + TAGLINE.length + 4;

/** Whether the big header should be used: a color-or-not terminal that is wide enough. */
export function logoFits(cols: number | undefined): boolean {
  return (cols ?? 0) >= LOGO_MIN_COLS;
}

function paintLogoRow(row: string, index: number, c: Palette): string {
  const solid = GRADIENT[index] ?? GRADIENT[GRADIENT.length - 1]!;
  let res = '';
  let run = '';
  let runShadow = false;
  const flush = () => {
    if (run) res += c.fg(runShadow ? SHADOW : solid, run);
    run = '';
  };
  for (const ch of row) {
    const shadow = ch !== '█' && ch !== ' ';
    if (ch === ' ') {
      run += ch;
      continue;
    }
    if (shadow !== runShadow) {
      flush();
      runShadow = shadow;
    }
    run += ch;
  }
  flush();
  return res;
}

/**
 * The large header: gradient block-letter logo on the left, name, tagline and the versioned
 * info line on the right. It always contains `pf v<version>` so the banner invariant holds.
 */
export function renderLogo(info: BannerInfo, c: Palette = err(), cols = 80): string {
  const side: string[] = [];
  side[0] = `${c.boldBrand('p u l p f i x e r')}`;
  side[1] = c.dim(TAGLINE);
  const rule = '░▒▓' + '█'.repeat(TAGLINE.length - 8) + '▓▒░';
  side[2] = [...rule].map((ch, i) => c.fg(GRADIENT[Math.min(GRADIENT.length - 1, Math.floor((i / rule.length) * GRADIENT.length))]!, ch)).join('');
  // The one-line banner appends the update hint; here the hint gets its own row below.
  const { latest, ...withoutLatest } = info;
  side[3] = renderBanner(withoutLatest, c);
  if (latest && compareVersions(latest, info.version) > 0) {
    side[4] = c.yellow('↑ v' + displayVersion(latest) + ' available, run pf update');
  }
  const rows = LOGO.map((row, i) => fitLine(`  ${paintLogoRow(row, i, c)}${GAP}${side[i] ?? ''}`, cols));
  return ['', ...rows, ''].join('\n');
}

export interface PrintOptions {
  /** Use the big logo when the terminal is a wide-enough TTY. */
  logo?: boolean;
}

export function printBanner(info: BannerInfo, opts: PrintOptions = {}): void {
  const cols = process.stderr.columns;
  if (opts.logo && process.stderr.isTTY && logoFits(cols)) {
    process.stderr.write(renderLogo(info, err(), cols) + '\n');
    return;
  }
  process.stderr.write(renderBanner(info) + '\n');
}

/** Plain width of a rendered block (for tests). */
export function blockWidth(block: string): number {
  return Math.max(0, ...block.split('\n').map((l) => stripAnsi(l).length));
}
