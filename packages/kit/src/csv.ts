/**
 * CSV (RFC 4180): a pure encoder and an incremental parser, shared by `pf db --csv` output and the CSV
 * adapter. No file access here.
 */

type Row = Record<string, unknown>;

/** A value as one line of text for a table or CSV cell. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (typeof v === 'object') return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

/** Every key of every row, in first-seen order. */
export function columnsOf(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/** A delimiter is one character that is not a quote or a line break. */
export function checkDelimiter(delimiter: string): string | null {
  if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) return 'a CSV delimiter is one character and not a quote or a line break';
  return null;
}

export const csvCell = (s: string, delimiter = ','): string => (s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One record as a line (no line break at the end). */
export const encodeCsvLine = (values: readonly string[], delimiter = ','): string => values.map((v) => csvCell(v, delimiter)).join(delimiter);

export interface ToCsvOptions {
  /** Columns and their order. Default: every key of every row. */
  columns?: readonly string[];
  delimiter?: string;
  /** Write the header line (default true). */
  header?: boolean;
}

/** Rows as CSV text, lines joined with `\n` and no line break at the end. Empty rows give an empty string unless `columns` is set. */
export function toCsv(rows: readonly Row[], opts: ToCsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ',';
  const cols = opts.columns ? [...opts.columns] : columnsOf(rows);
  const lines = opts.header === false ? [] : [encodeCsvLine(cols, delimiter)];
  for (const r of rows) lines.push(encodeCsvLine(cols.map((k) => cellText(r[k])), delimiter));
  return cols.length === 0 && rows.length === 0 ? '' : lines.join('\n');
}

type State = 'start' | 'plain' | 'quoted' | 'quote';

/**
 * Reads CSV in pieces. `push(text)` returns the records completed so far (arrays of strings); `end()`
 * returns the last one. Handles quoted fields with delimiters, doubled quotes and line breaks inside,
 * `\n`, `\r\n` and `\r` line ends (also when split between two chunks), and a leading byte order mark.
 * Blank lines are skipped. A quote in the middle of an unquoted field is kept as it is.
 */
export class CsvParser {
  private readonly delimiter: string;
  private state: State = 'start';
  private field = '';
  private record: string[] = [];
  private skipLf = false;
  private first = true;

  constructor(delimiter = ',') {
    const bad = checkDelimiter(delimiter);
    if (bad) throw new Error(bad);
    this.delimiter = delimiter;
  }

  private endField(): void {
    this.record.push(this.field);
    this.field = '';
    this.state = 'start';
  }

  private endRecord(out: string[][]): void {
    // A line with nothing on it is not a record; `""` on its own line is one empty value.
    const blank = this.state === 'start' && this.field === '' && this.record.length === 0;
    if (!blank) {
      this.endField();
      out.push(this.record);
    }
    this.record = [];
    this.field = '';
    this.state = 'start';
  }

  push(text: string): string[][] {
    const out: string[][] = [];
    let i = 0;
    if (this.first && text.length > 0) {
      this.first = false;
      if (text.charCodeAt(0) === 0xfeff) i = 1;
    }
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (this.skipLf) {
        this.skipLf = false;
        if (ch === '\n') continue;
      }
      if (this.state === 'quoted') {
        if (ch === '"') this.state = 'quote';
        else this.field += ch;
        continue;
      }
      if (this.state === 'quote') {
        if (ch === '"') {
          this.field += '"';
          this.state = 'quoted';
          continue;
        }
        this.state = 'plain'; // the quoted part is over; this character is read as plain
      }
      if (ch === this.delimiter) this.endField();
      else if (ch === '\n') this.endRecord(out);
      else if (ch === '\r') {
        this.endRecord(out);
        this.skipLf = true;
      } else if (ch === '"' && this.state === 'start') this.state = 'quoted';
      else {
        this.field += ch;
        this.state = 'plain';
      }
    }
    return out;
  }

  /** The record in progress, if any. Throws when a quoted field was never closed. */
  end(): string[][] {
    if (this.state === 'quoted') throw new Error('the CSV ends inside a quoted value (a quote is not closed)');
    const out: string[][] = [];
    this.endRecord(out);
    return out;
  }
}

/** Parse a whole text into records. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const p = new CsvParser(delimiter);
  return [...p.push(text), ...p.end()];
}
