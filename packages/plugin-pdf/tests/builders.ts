/** Small PDFs built in code, so the tests need no binary fixtures. */
import zlib from 'node:zlib';

export type Body = string | Buffer;

export function stream(dict: string, data: Body, compress = false): Buffer {
  let d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  let extra = '';
  if (compress) {
    d = zlib.deflateSync(d);
    extra = ' /Filter /FlateDecode';
  }
  return Buffer.concat([Buffer.from(`<< ${dict}${extra} /Length ${d.length} >>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]);
}

/** A classic cross-reference PDF from `[number, body]` objects (object 1 must be the catalog). */
export function classicPdf(objs: [number, Body][], trailerExtra = ''): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = parts[0]!.length;
  const offsets = new Map<number, number>();
  for (const [n, body] of objs) {
    offsets.set(n, pos);
    const chunk = Buffer.concat([Buffer.from(`${n} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    pos += chunk.length;
  }
  const size = Math.max(...objs.map(([n]) => n)) + 1;
  const lines = ['xref', `0 ${size}`, '0000000000 65535 f '];
  for (let i = 1; i < size; i++) lines.push(offsets.has(i) ? `${String(offsets.get(i)).padStart(10, '0')} 00000 n ` : '0000000000 00000 f ');
  parts.push(Buffer.from(`${lines.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** A one page document: the page draws `content` with font F1 (Helvetica) and any extra resources. */
export function onePage(content: string, opts: { fonts?: string; font?: string; resources?: string; extra?: [number, Body][]; pageExtra?: string; compress?: boolean; trailerExtra?: string; catalogExtra?: string } = {}): Buffer {
  return classicPdf(
    [
      [1, `<< /Type /Catalog /Pages 2 0 R ${opts.catalogExtra ?? ''} >>`],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << ${opts.fonts ?? '/F1 5 0 R'} >> ${opts.resources ?? ''} >> ${opts.pageExtra ?? ''} >>`],
      [4, stream('', content, opts.compress)],
      [5, opts.font ?? HELV],
      ...(opts.extra ?? []),
    ],
    opts.trailerExtra,
  );
}

/** The same kind of document with an xref stream and an object stream (PDF 1.5). */
export function modernPdf(content: string): Buffer {
  const header = Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const members: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
    [5, HELV],
  ];
  let first = '';
  let bodies = '';
  for (const [n, b] of members) {
    first += `${n} ${bodies.length} `;
    bodies += b + '\n';
  }
  const objStm = stream(`/Type /ObjStm /N ${members.length} /First ${first.length}`, first + bodies, true);
  const contentObj = stream('', content, true);
  const objs: [number, Buffer][] = [
    [4, contentObj],
    [6, objStm],
  ];
  const parts: Buffer[] = [header];
  let pos = header.length;
  const off = new Map<number, number>();
  for (const [n, body] of objs) {
    off.set(n, pos);
    const chunk = Buffer.concat([Buffer.from(`${n} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    pos += chunk.length;
  }
  // xref stream object 7: W [1 2 1], entries 0..7
  const rec = (t: number, a: number, b: number): number[] => [t, (a >> 8) & 0xff, a & 0xff, b];
  const entries: number[] = [...rec(0, 0, 255)];
  for (let n = 1; n <= 7; n++) {
    if (n === 1 || n === 2 || n === 3 || n === 5) entries.push(...rec(2, 6, members.findIndex(([m]) => m === n)));
    else if (n === 7) entries.push(...rec(1, pos, 0));
    else entries.push(...rec(1, off.get(n)!, 0));
  }
  const xrefData = zlib.deflateSync(Buffer.from(entries));
  const xrefObj = Buffer.concat([
    Buffer.from(`7 0 obj\n<< /Type /XRef /Size 8 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /Length ${xrefData.length} >>\nstream\n`),
    xrefData,
    Buffer.from('\nendstream\nendobj\n'),
  ]);
  parts.push(xrefObj, Buffer.from(`startxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}
