import fs from 'node:fs';
import path from 'node:path';

/**
 * Templates are data: `template.json` plus a `files/` tree. Rendering fills `{{param}}` and
 * `{{version:@pulpfixer/<pkg>}}` placeholders and never runs anything from the template.
 */
export interface TemplateParam {
  prompt: string;
  help?: string;
  /** May use earlier params (`{{name}}`). A param without a default is required. */
  default?: string;
  /** A regular expression the whole value must match. */
  pattern?: string;
  choices?: string[];
}

export interface Template {
  summary: string;
  /** Default target directory, a single folder name (may use params: `query-{{name}}`). */
  dir: string;
  /** In order; the first one is the positional argument of `pf template apply`. */
  params: Record<string, TemplateParam>;
  /** File names to rename when copying (`_gitignore` -> `.gitignore`): npm drops or renames such files on publish. */
  rename: Record<string, string>;
  /** Hint lines printed after applying (may use params). */
  next: string[];
}

export type Values = Record<string, string>;
/** Versions of the `@pulpfixer` packages bundled with this pf, by package name. */
export type Versions = Record<string, string>;

export interface RenderedFile {
  /** Relative to the target directory, `/`-separated. */
  path: string;
  content: string | Buffer;
}

const PARAM_NAME_RE = /^[a-z][a-zA-Z0-9]*$/;
const PLAIN_FILE_RE = /^(?!\.{1,2}$)[^/\\\0]+$/;
const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const FORBIDDEN_RE = /["'`\\\n\r\0]|\{\{|\}\}/;

/** `productId` -> `--product-id`. */
export const paramFlag = (name: string): string => `--${name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;

/** Check the content of a `template.json`. Returns the template, or why it is unusable. */
export function validateTemplate(value: unknown): Template | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'template.json is not an object';
  const o = value as Record<string, unknown>;
  if (o.summary !== undefined && typeof o.summary !== 'string') return '"summary" must be a string';
  if (typeof o.dir !== 'string' || !o.dir) return 'template.json needs a "dir" (the default folder name)';
  const params: Record<string, TemplateParam> = {};
  if (o.params !== undefined) {
    if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) return '"params" must be an object of params by name';
    for (const [name, raw] of Object.entries(o.params)) {
      if (!PARAM_NAME_RE.test(name)) return `"${name}" is not a param name (camelCase letters and digits)`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `param "${name}" must be an object`;
      const p = raw as Record<string, unknown>;
      if (typeof p.prompt !== 'string' || !p.prompt) return `param "${name}" needs a "prompt"`;
      for (const k of ['help', 'default', 'pattern'] as const) {
        if (p[k] !== undefined && typeof p[k] !== 'string') return `"${k}" of param "${name}" must be a string`;
      }
      if (typeof p.pattern === 'string') {
        try {
          new RegExp(p.pattern);
        } catch {
          return `"pattern" of param "${name}" is not a valid regular expression`;
        }
      }
      if (p.choices !== undefined && (!Array.isArray(p.choices) || !p.choices.length || p.choices.some((x) => typeof x !== 'string' || !x))) {
        return `"choices" of param "${name}" must be a non-empty array of strings`;
      }
      params[name] = {
        prompt: p.prompt,
        ...(typeof p.help === 'string' ? { help: p.help } : {}),
        ...(typeof p.default === 'string' ? { default: p.default } : {}),
        ...(typeof p.pattern === 'string' ? { pattern: p.pattern } : {}),
        ...(Array.isArray(p.choices) ? { choices: p.choices as string[] } : {}),
      };
    }
  }
  const rename: Record<string, string> = {};
  if (o.rename !== undefined) {
    if (!o.rename || typeof o.rename !== 'object' || Array.isArray(o.rename)) return '"rename" must be an object of file names';
    for (const [from, to] of Object.entries(o.rename)) {
      if (!PLAIN_FILE_RE.test(from) || typeof to !== 'string' || !PLAIN_FILE_RE.test(to)) return `"rename" maps plain file names (got "${from}")`;
      rename[from] = to;
    }
  }
  const next: string[] = [];
  if (o.next !== undefined) {
    if (!Array.isArray(o.next) || o.next.some((x) => typeof x !== 'string')) return '"next" must be an array of strings';
    next.push(...(o.next as string[]));
  }
  return { summary: typeof o.summary === 'string' ? o.summary : '', dir: o.dir, params, rename, next };
}

/** Why `value` is not acceptable for the param, or null. */
export function paramProblem(name: string, def: TemplateParam, value: string): string | null {
  const flag = paramFlag(name);
  if (!value) return `${flag} is required${def.help ? ` (${def.help})` : ''}`;
  if (FORBIDDEN_RE.test(value)) return `${flag} may not contain quotes, backslashes, backticks, {{ }} or newlines`;
  if (def.choices && !def.choices.includes(value)) return `${flag} must be one of ${def.choices.join(', ')} (got "${value}")`;
  if (def.pattern && !new RegExp(`^(?:${def.pattern})$`).test(value)) return `${flag} must match ${def.pattern}${def.help ? ` (${def.help})` : ''} (got "${value}")`;
  return null;
}

/** Fill the placeholders in `text`. An unknown param or an unbundled package is an error. */
export function substitute(text: string, values: Values, versions: Versions = {}): { text: string } | { error: string } {
  let problem: string | null = null;
  const result = text.replace(PLACEHOLDER_RE, (whole, key: string) => {
    if (key.startsWith('version:')) {
      const pkg = key.slice('version:'.length).trim();
      const v = versions[pkg];
      if (v) return v;
      problem ??= `${whole}: ${pkg} is not a package bundled with this pf`;
      return whole;
    }
    if (Object.hasOwn(values, key)) return values[key]!;
    problem ??= `${whole} is not a param of this template`;
    return whole;
  });
  return problem ? { error: problem } : { text: result };
}

/** The default of a param with the earlier values filled in, or undefined. */
export function defaultOf(def: TemplateParam, values: Values): string | undefined {
  if (def.default === undefined) return undefined;
  const r = substitute(def.default, values);
  return 'text' in r ? r.text : undefined;
}

/**
 * The values of every param, in order: the given one, else the default (earlier params filled in).
 * Each value is checked; a param with neither is missing.
 */
export function resolveParams(params: Record<string, TemplateParam>, given: Values): { values: Values } | { error: string; missing?: string } {
  const values: Values = {};
  for (const name of Object.keys(given)) if (!Object.hasOwn(params, name)) return { error: `${paramFlag(name)} is not a param of this template` };
  for (const [name, def] of Object.entries(params)) {
    let value = Object.hasOwn(given, name) ? given[name]! : undefined;
    if (value === undefined && def.default !== undefined) {
      const r = substitute(def.default, values);
      if ('error' in r) return { error: `default of ${paramFlag(name)}: ${r.error}` };
      value = r.text;
    }
    if (value === undefined) return { error: `${paramFlag(name)} is required${def.help ? ` (${def.help})` : ''}`, missing: name };
    const problem = paramProblem(name, def, value);
    if (problem) return { error: problem };
    values[name] = value;
  }
  return { values };
}

/** A rendered relative path is safe to write when it has plain segments only and stays out of `.git`. */
export function safeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every((seg) => PLAIN_FILE_RE.test(seg) && seg !== '.git');
}

/** The default folder name of a template, filled in. */
export function renderDir(template: Template, values: Values): { dir: string } | { error: string } {
  const r = substitute(template.dir, values);
  if ('error' in r) return { error: `"dir": ${r.error}` };
  if (!PLAIN_FILE_RE.test(r.text) || r.text.includes('/')) return { error: `"dir" must be one folder name (got "${r.text}")` };
  return { dir: r.text };
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8000).includes(0);

/**
 * Read `filesDir` and fill it in: paths and text contents get their placeholders replaced, names in
 * `template.rename` are renamed, binary files are copied as they are. Symlinks and unsafe paths are errors.
 */
export function renderTemplate(filesDir: string, template: Template, values: Values, versions: Versions = {}): { files: RenderedFile[] } | { error: string } {
  const files: RenderedFile[] = [];
  const walk = (dir: string, rel: string): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return `cannot read ${rel || 'files/'}: ${e instanceof Error ? e.message : String(e)}`;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const srcRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) return `${srcRel} is a symlink; templates hold plain files only`;
      const renamed = Object.hasOwn(template.rename, ent.name) ? template.rename[ent.name]! : ent.name;
      const name = substitute(renamed, values, versions);
      if ('error' in name) return `${srcRel}: ${name.error}`;
      const outRel = rel ? `${rel}/${name.text}` : name.text;
      if (ent.isDirectory()) {
        const problem = walk(path.join(dir, ent.name), outRel);
        if (problem) return problem;
        continue;
      }
      if (!ent.isFile()) return `${srcRel} is not a plain file`;
      if (!safeRelPath(outRel)) return `${srcRel} would be written outside the target (${outRel})`;
      const buf = fs.readFileSync(path.join(dir, ent.name));
      if (isBinary(buf)) {
        files.push({ path: outRel, content: buf });
        continue;
      }
      const text = substitute(buf.toString('utf8'), values, versions);
      if ('error' in text) return `${srcRel}: ${text.error}`;
      files.push({ path: outRel, content: text.text });
    }
    return null;
  };
  const problem = walk(filesDir, '');
  if (problem) return { error: problem };
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) return { error: `two files render to ${f.path}` };
    seen.add(f.path);
  }
  return { files };
}
