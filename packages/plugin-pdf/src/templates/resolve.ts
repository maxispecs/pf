/**
 * Finding a template: a `PdfTemplate` object (code), a built-in id, a path to a layout file (ends in `.json`
 * or has a folder in it), or the name of a saved layout in `~/.pf/pdf/templates/<name>.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from '@pulpfixer/kit/constants';
import { PdfError } from '../errors.js';
import { BUILTIN_TEMPLATES } from './builtin.js';
import { layoutTemplate, parseLayoutText } from './json.js';
import { validatePdfTemplate, type PdfTemplate } from './types.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LAYOUT_BYTES = 1024 * 1024;

export const userTemplateDir = (): string => path.join(pfHome(), 'pdf', 'templates');

export function builtinTemplate(id: string): PdfTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

/** The saved layouts: name and file. */
export function listUserTemplates(dir = userTemplateDir()): { name: string; file: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && NAME.test(n.slice(0, -5)))
    .map((n) => ({ name: n.slice(0, -5), file: path.join(dir, n) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read and validate a layout file. */
export function loadLayoutFile(file: string, id?: string): PdfTemplate {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new PdfError(`the layout file ${file} does not exist`);
  }
  if (!st.isFile()) throw new PdfError(`${file} is not a file`);
  if (st.size > MAX_LAYOUT_BYTES) throw new PdfError(`${file} is too big to be a layout`);
  const layout = parseLayoutText(fs.readFileSync(file, 'utf8'), file);
  return layoutTemplate(layout, id ?? path.basename(file).replace(/\.json$/, ''));
}

export function resolveTemplate(ref: string | PdfTemplate, cwd = process.cwd()): PdfTemplate {
  if (typeof ref !== 'string') {
    const bad = validatePdfTemplate(ref);
    if (bad) throw new PdfError(bad);
    return ref;
  }
  const builtin = builtinTemplate(ref);
  if (builtin) return builtin;
  if (ref.endsWith('.json') || ref.includes('/') || ref.includes('\\')) return loadLayoutFile(path.resolve(cwd, ref));
  if (NAME.test(ref)) {
    const file = path.join(userTemplateDir(), `${ref}.json`);
    if (fs.existsSync(file)) return loadLayoutFile(file, ref);
  }
  const saved = listUserTemplates().map((t) => t.name);
  throw new PdfError(`no PDF template "${ref}"`, `built in: ${BUILTIN_TEMPLATES.map((t) => t.id).join(', ')}${saved.length ? `; saved: ${saved.join(', ')}` : ''}; or a path to a .json layout file`);
}
