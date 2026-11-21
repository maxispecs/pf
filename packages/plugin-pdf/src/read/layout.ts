/**
 * Reading order: text items to lines. Items sit on the same line when their baselines are close; within a
 * line they are ordered by x and a space goes where the gap between two items is wider than a word space.
 * Pure.
 */
import type { TextItem } from './content.js';

export interface Line {
  /** The baseline, in points from the bottom of the page. */
  y: number;
  /** Where the line starts. */
  x: number;
  text: string;
  /** The largest font size on the line. */
  size: number;
}

export function buildLines(items: readonly TextItem[]): Line[] {
  const live = items.filter((i) => i.text !== '');
  const sorted = [...live].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  let refY = Number.NaN;
  let refSize = 0;
  for (const it of sorted) {
    if (rows.length && Math.abs(it.y - refY) <= Math.max(1, 0.4 * Math.min(it.size, refSize))) rows[rows.length - 1]!.push(it);
    else {
      rows.push([it]);
      refY = it.y;
      refSize = it.size;
    }
  }
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let text = '';
    let prev: TextItem | null = null;
    for (const it of row) {
      if (prev) {
        const gap = it.x - (prev.x + prev.width);
        const spaced = /\s$/.test(text) || /^\s/.test(it.text);
        if (!spaced && gap > 0.15 * Math.min(it.size, prev.size)) text += ' ';
      }
      text += it.text;
      prev = it;
    }
    text = text.replace(/[ \t]+$/, '');
    if (text.trim() === '') continue;
    lines.push({ y: Math.max(...row.map((r) => r.y)), x: row[0]!.x, text, size: Math.max(...row.map((r) => r.size)) });
  }
  return lines;
}

/** The lines of a page as text. */
export const linesToText = (lines: readonly Line[]): string => lines.map((l) => l.text).join('\n');
