import { fitLine, out, stripAnsi, type Palette } from './palette.js';

/**
 * Text helpers: colored command samples, status badges, headings, lists and a small table.
 * Every helper returns a string (callers pick stdout or stderr) and takes the palette to
 * paint with, so tests can pass a color-off palette.
 */

/** The pieces a command sample is painted from. */
export function term(c: Palette = out()) {
  return {
    /** The `$ ` in front of a command. */
    prefix: (s = '$ ') => c.dim(s),
    /** The program: `pf` is bold red, anything else is bold. */
    command: (s: string) => (s === 'pf' ? c.bold(c.red(s)) : c.bold(s)),
    /** The subcommand right after the program. */
    sub: (s: string) => c.bold(c.green(s)),
    /** `<required>` and `[optional]` placeholders. */
    args: (s: string) => c.blue(s),
    /** `--flag` and `-f`. */
    flag: (s: string) => c.cyan(s),
    /** Brackets, shell operators and trailing notes. */
    punct: (s: string) => c.dim(s),
    /** `$ pf dev --dry-run` from its parts. */
    format(command: string, sub?: string, args?: string): string {
      return [this.prefix(), this.command(command), sub ? ' ' + this.sub(sub) : '', args ? ' ' + this.args(args) : ''].join('');
    },
  };
}

// Whitespace, quoted strings, a trailing `(in dir)` note, <placeholders>, flags, brackets, other words.
const TOKEN = /\s+|'[^']*'|"[^"]*"|\(in [^)]*\)|<[^>\s][^>]*>|-{1,2}[A-Za-z][\w-]*|--(?=\s|$)|\[|\]|[^\s[\]]+/g;
const OPERATOR = /^(&&|\|\||\||;)$/;

/**
 * Paint a command sample: `pf deploy staging [--dry-run] <name>` becomes program, subcommand,
 * flags and placeholders in their own colors. Anything unrecognised is left plain.
 */
export function termLine(line: string, c: Palette = out()): string {
  if (!c.on) return line;
  const t = term(c);
  let depth = 0;
  // 0: expecting the program, 1: expecting the subcommand, 2: arguments.
  let pos = 0;
  return line.replace(TOKEN, (tok) => {
    if (/^\s+$/.test(tok)) return tok;
    if (tok.startsWith('(in ')) return t.punct(tok);
    if (tok === '[') return (depth++, t.punct(tok));
    if (tok === ']') return (depth = Math.max(0, depth - 1), t.punct(tok));
    if (tok.startsWith('<') && tok.endsWith('>')) return t.args(tok);
    if (/^-/.test(tok) && tok !== '-') return t.flag(tok);
    if (tok[0] === "'" || tok[0] === '"') return tok;
    if (depth > 0) return t.args(tok);
    if (OPERATOR.test(tok)) {
      pos = 0;
      return t.punct(tok);
    }
    if (pos === 0) {
      pos = 1;
      return t.command(tok);
    }
    if (pos === 1) {
      pos = 2;
      return t.sub(tok);
    }
    return tok;
  });
}

/** `$ <colored command>`: how a command is echoed before it runs. */
export function promptLine(line: string, c: Palette = out()): string {
  return term(c).prefix() + termLine(line, c);
}

export type BadgeKind = 'error' | 'warning' | 'success' | 'info';

// Bold text on a bright background, like the 1.x badges. Black text on the light ones.
const BADGE: Record<BadgeKind, string> = {
  error: '1;97;101',
  warning: '1;30;103',
  success: '1;30;102',
  info: '1;30;106',
};

/** ` error ` on a colored background; plain `error:` without color. */
export function badgeLabel(kind: BadgeKind, c: Palette = out()): string {
  return c.on ? `\x1b[${BADGE[kind]}m ${kind} \x1b[0m` : `${kind}:`;
}

const badgeFor = (kind: BadgeKind) => (msg: string, c: Palette = out()) => `${badgeLabel(kind, c)} ${msg}`;

/** `badge.error('no repo')` is a label followed by the message. */
export const badge = {
  error: badgeFor('error'),
  warning: badgeFor('warning'),
  success: badgeFor('success'),
  info: badgeFor('info'),
};

/** Top-level title. */
export const h1 = (title: string, c: Palette = out()): string => c.boldBrand(title);

/** Section title. */
export const h2 = (title: string, c: Palette = out()): string => c.dim(c.bold(title));

/** Blank lines. */
export const br = (lines = 1): string => '\n'.repeat(lines);

/** Bulleted list, one item per line. */
export function ul(lines: string[], c: Palette = out(), dot = '-'): string {
  return lines.map((l) => `${c.dim(dot)} ${l}`).join('\n');
}

/** Numbered list, one item per line. */
export function ol(lines: string[], c: Palette = out(), dot = '.'): string {
  return lines.map((l, i) => `${c.dim(String(i + 1) + dot)} ${l}`).join('\n');
}

export interface TableOptions {
  /** Cut lines to this many columns (the right border is lost on narrow terminals). */
  cols?: number;
}

const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));

/** Box-drawn table. Cells may be colored: widths are measured on the visible text. */
export function table(head: string[], rows: string[][], c: Palette = out(), opts: TableOptions = {}): string {
  const widths = head.map((h, i) => Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  const edge = (l: string, m: string, r: string) => c.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const row = (cells: string[]) => c.dim('│') + widths.map((w, i) => ` ${pad(cells[i] ?? '', w)} `).join(c.dim('│')) + c.dim('│');
  const lines = [edge('┌', '┬', '┐'), row(head.map((h) => c.bold(h))), edge('├', '┼', '┤'), ...rows.map(row), edge('└', '┴', '┘')];
  return (opts.cols ? lines.map((l) => fitLine(l, opts.cols!)) : lines).join('\n');
}

/** The old two-column `Usage | Description` table, with each usage line painted. */
export function usageTable(entries: { usage: string; summary: string }[], c: Palette = out(), opts: TableOptions = {}): string {
  return table(
    ['Usage', 'Description'],
    entries.map((e) => [promptLine(e.usage, c), e.summary]),
    c,
    opts,
  );
}
