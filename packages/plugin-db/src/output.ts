import type { Palette } from '@pulpfixer/kit/ui/palette';
import { table } from '@pulpfixer/kit/ui/text';

export type Format = 'table' | 'json' | 'csv';

type Row = Record<string, unknown>;

/** A value as one line of text for a table or CSV cell. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (typeof v === 'object') return JSON.stringify(v, jsonReplacer);
  return String(v);
}

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

/** What a query gave back, as rows (an array of objects, or a result with `rows`) or null when it is something else. */
export function rowsOf(result: unknown): Row[] | null {
  if (Array.isArray(result) && result.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: Row[] }).rows;
  return null;
}

function columnsOf(rows: Row[]): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
}

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows: Row[]): string {
  const cols = columnsOf(rows);
  return [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((k) => csvCell(cellText(r[k]))).join(','))].join('\n');
}

/**
 * Text for stdout. Rows become a table, JSON or CSV; a write result says how many rows it changed;
 * nothing prints nothing; anything else is JSON.
 */
export function render(result: unknown, format: Format, c: Palette): string {
  if (result === undefined || result === null) return '';
  const rows = rowsOf(result);
  if (format === 'json') return JSON.stringify(rows ?? result, jsonReplacer, 2);
  if (rows) {
    if (format === 'csv') return rows.length ? toCsv(rows) : '';
    if (rows.length === 0) {
      const affected = (result as { affected?: unknown }).affected;
      return typeof affected === 'number' ? `${affected} row${affected === 1 ? '' : 's'} affected` : c.dim('(no rows)');
    }
    const cols = columnsOf(rows);
    return table(cols, rows.map((r) => cols.map((k) => cellText(r[k]))), c);
  }
  return typeof result === 'string' ? result : JSON.stringify(result, jsonReplacer, 2);
}
