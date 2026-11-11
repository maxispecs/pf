/**
 * Just enough JSONC (JSON with comments and trailing commas, what editors keep in settings.json) to
 * read a settings file and to set top-level keys in it without touching the rest of the text: comments,
 * key order and formatting survive.
 */

/** Index of the first character after whitespace and comments, starting at `i`. */
function skipWs(text: string, i: number): number {
  for (;;) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\ufeff') i++;
    else if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return i;
  }
}

/** Index after the string literal that starts at `i` (a quote); -1 when it never closes. */
function skipString(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j + 1;
    else if (text[j] === '\n') return -1;
  }
  return -1;
}

/** Index after the value that starts at `i`; -1 when it is malformed. */
function skipValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return skipString(text, i);
  if (ch === '{' || ch === '[') {
    let depth = 0;
    for (let j = i; j < text.length; ) {
      const c = text[j]!;
      if (c === '"') {
        j = skipString(text, j);
        if (j < 0) return -1;
        continue;
      }
      if (c === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
        j = skipWs(text, j);
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return -1;
  }
  let j = i;
  while (j < text.length && !/[\s,}\]/]/.test(text[j]!)) j++;
  return j > i ? j : -1;
}

/** Text with comments and trailing commas removed (positions are not kept), ready for JSON.parse. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = skipString(text, i);
      if (end < 0) return out + text.slice(i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipWs(text, i);
      out += ' ';
    } else if (ch === ',') {
      const next = skipWs(text, i + 1);
      if (text[next] === '}' || text[next] === ']') i++;
      else {
        out += ch;
        i++;
      }
    } else if (ch === '\ufeff') i++;
    else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The top-level object of a JSONC text. Empty text is an empty object; anything else that is not an object is null. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  if (skipWs(text, 0) >= text.length) return {};
  try {
    const value = JSON.parse(stripJsonc(text)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Prop {
  key: string;
  valueStart: number;
  valueEnd: number;
  /** Where the property's line starts (its key). */
  start: number;
}

interface Scan {
  props: Prop[];
  open: number;
  close: number;
}

/** Locate the top-level properties of a JSONC object; null when the text is not one. */
function scanObject(text: string): Scan | null {
  let i = skipWs(text, 0);
  if (text[i] !== '{') return null;
  const open = i;
  i++;
  const props: Prop[] = [];
  for (;;) {
    i = skipWs(text, i);
    if (text[i] === '}') return { props, open, close: i };
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] !== '"') return null;
    const keyEnd = skipString(text, i);
    if (keyEnd < 0) return null;
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      return null;
    }
    const colon = skipWs(text, keyEnd);
    if (text[colon] !== ':') return null;
    const valueStart = skipWs(text, colon + 1);
    const valueEnd = skipValue(text, valueStart);
    if (valueEnd < 0) return null;
    props.push({ key, start: i, valueStart, valueEnd });
    i = valueEnd;
  }
}

/** The indentation the file uses for its top-level keys (two spaces when it has none to copy). */
function indentOf(text: string, scan: Scan): string {
  const first = scan.props[0];
  if (!first) return '  ';
  const lineStart = text.lastIndexOf('\n', first.start) + 1;
  const prefix = text.slice(lineStart, first.start);
  return /^[ \t]+$/.test(prefix) ? prefix : '  ';
}

/** `value` as JSON whose continuation lines are indented to sit under a key at `indent`. */
function formatValue(value: unknown, indent: string): string {
  const unit = indent.includes('\t') ? '\t' : indent.length > 0 && indent.length <= 8 ? indent : '  ';
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);
}

/**
 * Set top-level keys of a JSONC object: an existing key has only its value replaced, new keys are
 * appended in the given order. Returns the new text, or null when `text` is not a JSON object (the
 * caller must not overwrite a file it cannot read). Empty text starts a new object.
 */
export function setTopLevelKeys(text: string, entries: Record<string, unknown>): string | null {
  const keys = Object.keys(entries);
  const source = skipWs(text, 0) >= text.length ? '{}\n' : text;
  if (keys.length === 0) return source === text ? text : source;
  const scan = scanObject(source);
  if (!scan) return null;
  const indent = indentOf(source, scan);

  const last = new Map<string, Prop>();
  for (const p of scan.props) last.set(p.key, p);

  const edits: { from: number; to: number; text: string }[] = [];
  const added: string[] = [];
  for (const key of keys) {
    const prop = last.get(key);
    if (prop) edits.push({ from: prop.valueStart, to: prop.valueEnd, text: formatValue(entries[key], indent) });
    else added.push(`${indent}${JSON.stringify(key)}: ${formatValue(entries[key], indent)}`);
  }

  if (added.length) {
    const tail = scan.props[scan.props.length - 1];
    if (tail) edits.push({ from: tail.valueEnd, to: tail.valueEnd, text: `,\n${added.join(',\n')}` });
    else if (source.slice(scan.open + 1, scan.close).trim() === '') edits.push({ from: scan.open + 1, to: scan.close, text: `\n${added.join(',\n')}\n` });
    else edits.push({ from: scan.open + 1, to: scan.open + 1, text: `\n${added.join(',\n')}` });
  }

  let result = source;
  for (const e of edits.sort((a, b) => b.from - a.from)) result = result.slice(0, e.from) + e.text + result.slice(e.to);
  return result;
}

/** Deep equality for JSON values. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
