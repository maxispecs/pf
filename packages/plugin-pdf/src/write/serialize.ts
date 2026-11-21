/**
 * Turns finished pages into PDF bytes: the objects (catalog, page tree, info, the standard fonts, a page and a
 * Flate-compressed content stream per page), the cross-reference table and the trailer.
 */
import zlib from 'node:zlib';
import { STD_FONTS, type StdFont } from '../metrics.js';

export interface PageData {
  width: number;
  height: number;
  /** The content stream (ASCII: text bytes above 126 are octal escapes). */
  content: string;
  fonts: ReadonlySet<StdFont>;
}

export interface InfoData {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  date: Date;
}

/** The resource name of a standard font on every page. */
export const fontResource = (f: StdFont): string => `F${STD_FONTS.indexOf(f) + 1}`;

const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''));

function textString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, '\\$&')})`;
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex.toUpperCase()}>`;
}

const pdfDate = (d: Date): string => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

export function serialize(pages: readonly PageData[], info: InfoData): Buffer {
  const used = STD_FONTS.filter((f) => pages.some((p) => p.fonts.has(f)));
  const fontNum = new Map<StdFont, number>();
  const FIRST_FONT = 4;
  used.forEach((f, i) => fontNum.set(f, FIRST_FONT + i));
  const firstPage = FIRST_FONT + used.length;
  const objects: Buffer[] = [];
  const set = (n: number, body: string | Buffer): void => {
    objects[n - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  };

  const pageObj = (i: number): number => firstPage + 2 * i;
  set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  set(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  const entries: string[] = [];
  if (info.title) entries.push(`/Title ${textString(info.title)}`);
  if (info.author) entries.push(`/Author ${textString(info.author)}`);
  if (info.subject) entries.push(`/Subject ${textString(info.subject)}`);
  if (info.keywords) entries.push(`/Keywords ${textString(info.keywords)}`);
  entries.push(`/Creator ${textString(info.creator ?? 'pf')}`, `/Producer ${textString(info.producer ?? 'pf pdf')}`, `/CreationDate (${pdfDate(info.date)})`);
  set(3, `<< ${entries.join(' ')} >>`);
  for (const f of used) set(fontNum.get(f)!, `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`);

  pages.forEach((p, i) => {
    const res = [...p.fonts].sort((a, b) => STD_FONTS.indexOf(a) - STD_FONTS.indexOf(b)).map((f) => `/${fontResource(f)} ${fontNum.get(f)} 0 R`);
    set(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << /Font << ${res.join(' ')} >> >> /Contents ${pageObj(i) + 1} 0 R >>`);
    const z = zlib.deflateSync(Buffer.from(p.content, 'latin1'));
    set(pageObj(i) + 1, Buffer.concat([Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]));
  });

  const parts: Buffer[] = [Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const o of offsets) xref.push(`${String(o).padStart(10, '0')} 00000 n `);
  parts.push(Buffer.from(`${xref.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
