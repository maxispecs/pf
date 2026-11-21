/**
 * Single-byte text encodings PDF uses, as Unicode strings: WinAnsi (the one the writer emits), MacRoman,
 * StandardEncoding and PDFDocEncoding, plus a compact glyph-name table for `/Differences` arrays.
 * Pure data and lookups.
 */

/** WinAnsi (cp1252) 0x80..0x9F; '' marks a code with no character. */
export const WIN_ANSI_80: readonly string[] = [
  '€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
  '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ',
];

/** PDFDocEncoding 0x80..0xA0 (info strings without a byte order mark); '' marks a code with no character. */
export const PDF_DOC_80: readonly string[] = [
  '•', '†', '‡', '…', '—', '–', 'ƒ', '⁄', '‹', '›', '−', '‰', '„', '“', '”', '‘',
  '’', '‚', '™', 'ﬁ', 'ﬂ', 'Ł', 'Œ', 'Š', 'Ÿ', 'Ž', 'ı', 'ł', 'œ', 'š', 'ž', '',
  '€',
];

/** MacRomanEncoding 0x80..0xFF. */
export const MAC_ROMAN_80 =
  'ÄÅÇÉÑÖÜáàâäãåçéè' +
  'êëíìîïñóòôöõúùûü' +
  '†°¢£§•¶ß®©™´¨≠ÆØ' +
  '∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ' +
  '–—“”‘’÷◊ÿŸ⁄¤‹›ﬁﬂ' +
  '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ' +
  '\uf8ffÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/** StandardEncoding, the parts that differ from ASCII / Latin-1. */
const STANDARD_SPARSE: Record<number, string> = {
  0x27: '’', 0x60: '‘', 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: "'",
  0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'ﬁ', 0xaf: 'ﬂ', 0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶',
  0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿', 0xc1: '`', 0xc2: '´', 0xc3: 'ˆ',
  0xc4: '˜', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸', 0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—',
  0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
};

export type BaseEncoding = 'WinAnsiEncoding' | 'MacRomanEncoding' | 'StandardEncoding' | 'PDFDocEncoding';

function build(name: BaseEncoding): string[] {
  const t: string[] = new Array<string>(256).fill('');
  for (let i = 32; i < 127; i++) t[i] = String.fromCharCode(i);
  if (name === 'WinAnsiEncoding') {
    WIN_ANSI_80.forEach((s, i) => (t[0x80 + i] = s));
    for (let i = 0xa0; i < 256; i++) t[i] = String.fromCharCode(i);
  } else if (name === 'MacRomanEncoding') {
    [...MAC_ROMAN_80].forEach((s, i) => (t[0x80 + i] = s));
  } else if (name === 'PDFDocEncoding') {
    PDF_DOC_80.forEach((s, i) => (t[0x80 + i] = s));
    for (let i = 0xa1; i < 256; i++) t[i] = String.fromCharCode(i);
  } else {
    for (const [k, v] of Object.entries(STANDARD_SPARSE)) t[Number(k)] = v;
  }
  return t;
}

const cache = new Map<string, string[]>();

/** The 256 characters of a base encoding ('' where a code has none). A copy: callers may change it. */
export function baseEncoding(name: BaseEncoding): string[] {
  let t = cache.get(name);
  if (!t) cache.set(name, (t = build(name)));
  return [...t];
}

/** The byte WinAnsi gives a character, or null when it has none (the writer then uses `?`). */
export function winAnsiByte(ch: string): number | null {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c < 127) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  const i = ch === '' ? -1 : WIN_ANSI_80.indexOf(ch);
  return i >= 0 ? 0x80 + i : null;
}

const NAMES: Record<string, string> = {};

const ASCII_NAMES =
  'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at'.split(' ');
ASCII_NAMES.forEach((n, i) => (NAMES[n] = String.fromCharCode(32 + i)));
for (let i = 0; i < 26; i++) {
  NAMES[String.fromCharCode(65 + i)] = String.fromCharCode(65 + i);
  NAMES[String.fromCharCode(97 + i)] = String.fromCharCode(97 + i);
}
'bracketleft backslash bracketright asciicircum underscore grave'.split(' ').forEach((n, i) => (NAMES[n] = String.fromCharCode(91 + i)));
'braceleft bar braceright asciitilde'.split(' ').forEach((n, i) => (NAMES[n] = String.fromCharCode(123 + i)));
(
  'nbspace exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown ' +
  'Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls ' +
  'agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'
)
  .split(' ')
  .forEach((n, i) => (NAMES[n] = String.fromCharCode(0xa0 + i)));
Object.assign(NAMES, {
  quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„', endash: '–', emdash: '—',
  bullet: '•', ellipsis: '…', dagger: '†', daggerdbl: '‡', perthousand: '‰', guilsinglleft: '‹', guilsinglright: '›', fi: 'ﬁ', fl: 'ﬂ',
  ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', trademark: '™', Euro: '€', florin: 'ƒ', circumflex: 'ˆ', tilde: '˜', caron: 'ˇ', breve: '˘', dotaccent: '˙',
  ring: '˚', ogonek: '˛', hungarumlaut: '˝', OE: 'Œ', oe: 'œ', Scaron: 'Š', scaron: 'š', Zcaron: 'Ž', zcaron: 'ž', Ydieresis: 'Ÿ',
  dotlessi: 'ı', Lslash: 'Ł', lslash: 'ł', fraction: '⁄', minus: '−', Delta: '∆', Omega: 'Ω', pi: 'π', summation: '∑', product: '∏',
  radical: '√', infinity: '∞', notequal: '≠', lessequal: '≤', greaterequal: '≥', approxequal: '≈', integral: '∫', partialdiff: '∂',
  lozenge: '◊', hyphenminus: '-', nonbreakingspace: '\u00a0', softhyphen: '\u00ad',
  Cacute: 'Ć', cacute: 'ć', Ccaron: 'Č', ccaron: 'č', Dcroat: 'Đ', dcroat: 'đ', Eogonek: 'Ę', eogonek: 'ę', Aogonek: 'Ą', aogonek: 'ą',
  Nacute: 'Ń', nacute: 'ń', Sacute: 'Ś', sacute: 'ś', Zacute: 'Ź', zacute: 'ź', Zdotaccent: 'Ż', zdotaccent: 'ż', Ecaron: 'Ě', ecaron: 'ě',
  Rcaron: 'Ř', rcaron: 'ř', Uring: 'Ů', uring: 'ů', Gbreve: 'Ğ', gbreve: 'ğ', Idotaccent: 'İ', Scedilla: 'Ş', scedilla: 'ş', Tcaron: 'Ť',
  tcaron: 'ť', Dcaron: 'Ď', dcaron: 'ď', Ncaron: 'Ň', ncaron: 'ň', Odblacute: 'Ő', odblacute: 'ő', Udblacute: 'Ű', udblacute: 'ű',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', sigma: 'σ', theta: 'θ', phi: 'φ', omega: 'ω',
  arrowleft: '←', arrowup: '↑', arrowright: '→', arrowdown: '↓', checkmark: '✓',
});

/**
 * The text of a glyph name from a `/Differences` array: a table name, `uniXXXX`, `uXXXX`, a suffixed variant
 * (`a.alt`), or a ligature (`f_i`). '' when the name says nothing about a character (`.notdef`, `g12`).
 */
export function glyphToUnicode(name: string): string {
  if (name === '' || name === '.notdef') return '';
  const direct = NAMES[name];
  if (direct !== undefined) return direct;
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) return m[1]!.match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  const dot = name.indexOf('.');
  if (dot > 0) return glyphToUnicode(name.slice(0, dot));
  if (name.includes('_')) return name.split('_').map(glyphToUnicode).join('');
  return '';
}
