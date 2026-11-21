/**
 * The standard PDF fonts (Helvetica, Times, Courier in four styles each): their names and glyph widths.
 * Widths for ASCII are the Adobe Core 14 AFM values (units of 1/1000 em). An accented letter has the width of
 * its base letter (exact for these fonts); the other Latin-1 symbols use close estimates, which only
 * affect alignment and line breaks, never what is drawn.
 */

export const STD_FONTS = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
] as const;
export type StdFont = (typeof STD_FONTS)[number];

interface Groups {
  p1: number[]; // space .. /
  d: number; // 0 .. 9
  p2: number[]; // : .. @
  U: number[]; // A .. Z
  p3: number[]; // [ .. `
  L: number[]; // a .. z
  p4: number[]; // { .. ~
}

const flat = (g: Groups): number[] => [...g.p1, ...Array<number>(10).fill(g.d), ...g.p2, ...g.U, ...g.p3, ...g.L, ...g.p4];

const HELVETICA: Groups = {
  p1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278], d: 556,
  p2: [278, 278, 584, 584, 584, 556, 1015],
  U: [667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611],
  p3: [278, 278, 278, 469, 556, 333],
  L: [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500],
  p4: [334, 260, 334, 584],
};
const HELVETICA_BOLD: Groups = {
  p1: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278], d: 556,
  p2: [333, 333, 584, 584, 584, 611, 975],
  U: [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611],
  p3: [333, 278, 333, 584, 556, 333],
  L: [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500],
  p4: [389, 280, 389, 584],
};
const TIMES: Groups = {
  p1: [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278], d: 500,
  p2: [278, 278, 564, 564, 564, 444, 921],
  U: [722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611],
  p3: [333, 278, 333, 469, 500, 333],
  L: [444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444],
  p4: [480, 200, 480, 541],
};
const TIMES_BOLD: Groups = {
  p1: [250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278], d: 500,
  p2: [333, 333, 570, 570, 570, 500, 930],
  U: [722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667],
  p3: [333, 278, 333, 581, 500, 333],
  L: [500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444],
  p4: [394, 220, 394, 520],
};
const TIMES_ITALIC: Groups = {
  p1: [250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278], d: 500,
  p2: [333, 333, 675, 675, 675, 500, 920],
  U: [611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722, 611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556],
  p3: [389, 278, 389, 422, 500, 333],
  L: [500, 500, 444, 500, 444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389],
  p4: [400, 275, 400, 541],
};
const TIMES_BOLD_ITALIC: Groups = {
  p1: [250, 389, 555, 500, 500, 833, 778, 278, 333, 333, 500, 570, 250, 333, 250, 278], d: 500,
  p2: [333, 333, 570, 570, 570, 500, 832],
  U: [667, 667, 667, 722, 667, 667, 722, 778, 389, 500, 667, 611, 889, 722, 722, 611, 722, 667, 556, 611, 722, 667, 889, 667, 611, 611],
  p3: [333, 278, 333, 570, 500, 333],
  L: [500, 500, 444, 500, 444, 333, 500, 556, 278, 278, 500, 278, 778, 556, 500, 500, 500, 389, 389, 278, 556, 444, 667, 500, 444, 389],
  p4: [348, 220, 348, 570],
};

/** ASCII widths (code 32 first) of the font each standard font shares its widths with; Courier is not here. */
export const ASCII_WIDTHS: Record<'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic', number[]> = {
  Helvetica: flat(HELVETICA),
  'Helvetica-Bold': flat(HELVETICA_BOLD),
  'Times-Roman': flat(TIMES),
  'Times-Bold': flat(TIMES_BOLD),
  'Times-Italic': flat(TIMES_ITALIC),
  'Times-BoldItalic': flat(TIMES_BOLD_ITALIC),
};

type Shared = keyof typeof ASCII_WIDTHS | 'Courier';

const SHARES: Record<StdFont, Shared> = {
  Helvetica: 'Helvetica', 'Helvetica-Bold': 'Helvetica-Bold', 'Helvetica-Oblique': 'Helvetica', 'Helvetica-BoldOblique': 'Helvetica-Bold',
  'Times-Roman': 'Times-Roman', 'Times-Bold': 'Times-Bold', 'Times-Italic': 'Times-Italic', 'Times-BoldItalic': 'Times-BoldItalic',
  Courier: 'Courier', 'Courier-Bold': 'Courier', 'Courier-Oblique': 'Courier', 'Courier-BoldOblique': 'Courier',
};

/** Helvetica widths of the Latin-1 and WinAnsi symbols that are not an accented letter. */
const EXTRA: Record<string, number> = {
  '×': 584, '÷': 584, '©': 737, '®': 737, '°': 400, '±': 584, 'µ': 556, '¶': 537, '§': 556, '¢': 556, '£': 556, '¥': 556, '¿': 611,
  '¡': 333, '«': 556, '»': 556, 'ß': 611, 'Æ': 1000, 'æ': 889, 'Ø': 778, 'ø': 611, 'Ð': 722, 'ð': 556, 'Þ': 667, 'þ': 556,
  '\u00a0': 278, '¼': 834, '½': 834, '¾': 834, '¹': 333, '²': 333, '³': 333, 'ª': 370, 'º': 365, '¬': 584, '¨': 333, '´': 333,
  '¸': 333, '¯': 333, '¦': 260, '¤': 556, '·': 278, '\u00ad': 333, '€': 556, '‚': 222, 'ƒ': 556, '„': 333, '…': 1000, '†': 556,
  '‡': 556, 'ˆ': 333, '‰': 1000, '‹': 333, 'Œ': 1000, '‘': 222, '’': 222, '“': 333, '”': 333, '•': 350, '–': 556, '—': 1000,
  '˜': 333, '™': 1000, '›': 333, 'œ': 944,
};

const SCALE: Record<string, number> = { Helvetica: 1, 'Helvetica-Bold': 1.04, 'Times-Roman': 0.9, 'Times-Bold': 0.93, 'Times-Italic': 0.9, 'Times-BoldItalic': 0.93 };

/** Width of one character in 1/1000 em. */
export function charWidth(font: StdFont, ch: string): number {
  const shared = SHARES[font];
  if (shared === 'Courier') return 600;
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[shared][code - 32]!;
  const extra = EXTRA[ch];
  if (extra !== undefined) return Math.round(extra * SCALE[shared]!);
  const base = ch.normalize('NFD')[0]!;
  if (base !== ch && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 126) return ASCII_WIDTHS[shared][base.charCodeAt(0) - 32]!;
  return Math.round(556 * SCALE[shared]!);
}

/** Width of a string in points at `size`. */
export function stringWidth(font: StdFont, text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(font, ch);
  return (w * size) / 1000;
}

/**
 * A standard font from a name: `Helvetica`, `Helvetica-Bold`, `Times-Roman`, or a family word (`sans`, `serif`,
 * `mono`, `arial`, `times`, `courier`, case does not matter) with `bold` / `italic` / `oblique` words. Null when
 * the name is none of these. A subset prefix (`ABCDEF+`) is ignored.
 */
export function parseFont(spec: string, bold = false, italic = false): StdFont | null {
  const s = spec.replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[\s_,-]+/g, '');
  let family: 'Helvetica' | 'Times' | 'Courier' | null = null;
  if (/courier|mono/.test(s)) family = 'Courier';
  else if (/times|serif/.test(s) && !/sans/.test(s)) family = 'Times';
  else if (/helvetica|arial|sans/.test(s)) family = 'Helvetica';
  if (!family) return null;
  const b = bold || /bold|black|heavy|semibold|demi/.test(s);
  const i = italic || /italic|oblique|slanted/.test(s);
  if (family === 'Times') return b && i ? 'Times-BoldItalic' : b ? 'Times-Bold' : i ? 'Times-Italic' : 'Times-Roman';
  const suffix = b && i ? '-BoldOblique' : b ? '-Bold' : i ? '-Oblique' : '';
  return `${family}${suffix}` as StdFont;
}
