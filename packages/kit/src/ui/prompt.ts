import type { Key } from 'node:readline';
import { listenKeys } from './keys.js';
import { err, fitLine, out, redPf, stripAnsi, type Palette } from './palette.js';

export interface ConfirmOptions {
  /** Flag that answers yes without a terminal, named in the hint when the answer defaults to no. */
  flag?: string;
}

/** One line for the yes/no prompt, with the current answer highlighted. */
export function renderConfirm(question: string, value: boolean, c: Palette): string {
  const yes = value ? `${c.brand('●')} ${c.bold('Yes')}` : c.dim('○ Yes');
  const no = value ? c.dim('○ No') : `${c.brand('●')} ${c.bold('No')}`;
  return `${c.boldBrand('?')} ${c.bold(question)}  ${yes}  ${no}  ${c.dim('(y/n)')}`;
}

export type ConfirmResult = { value: boolean; done: boolean };

/** Apply one keypress to the yes/no answer. `done` means the prompt is answered. */
export function confirmKey(value: boolean, str: string | undefined, key: Key): ConfirmResult {
  const name = key.name;
  if (key.ctrl && name === 'c') return { value: false, done: true };
  if (name === 'escape') return { value: false, done: true };
  if (name === 'return' || name === 'enter') return { value: value, done: true };
  if (!key.ctrl && !key.meta) {
    const s = (str ?? '').toLowerCase();
    if (s === 'y') return { value: true, done: true };
    if (s === 'n') return { value: false, done: true };
    if (name === 'h' || name === 'l') return { value: !value, done: false };
  }
  if (name === 'left' || name === 'right' || name === 'tab' || name === 'space') return { value: !value, done: false };
  return { value, done: false };
}

/**
 * Yes/no question answered with a single key (y, n, arrows, enter for the default).
 * Without a terminal it returns `fallback` without asking.
 */
export async function confirm(question: string, fallback = false, opts: ConfirmOptions = {}): Promise<boolean> {
  const stdin = process.stdin;
  const stream = process.stderr;
  const c = err();
  if (!stdin.isTTY || !stream.isTTY) {
    if (!fallback) stream.write(`${c.dim(`${question} → no (no terminal${opts.flag ? `; pass ${opts.flag} to say yes` : ''})`)}\n`);
    return fallback;
  }
  return new Promise((resolve) => {
    let value = fallback;
    let drawn = false;
    const width = () => Math.max(20, (stream.columns || 80) - 1);
    const render = () => {
      if (drawn) stream.write('\r\x1b[1A\x1b[J');
      stream.write(fitLine(renderConfirm(question, value, c), width()) + '\n');
      drawn = true;
    };
    const stop = listenKeys((str, key) => {
      const r = confirmKey(value, str, key);
      value = r.value;
      if (!r.done) return render();
      stop();
      stream.removeListener('resize', render);
      if (drawn) stream.write('\r\x1b[1A\x1b[J');
      stream.write(fitLine(`${c.boldBrand('?')} ${c.bold(question)} ${c.cyan(value ? 'Yes' : 'No')}`, width()) + '\n');
      resolve(value);
    }, stream);
    stream.on('resize', render);
    render();
  });
}

export interface AskOptions {
  /** Editable starting text. */
  initial?: string;
  /** Dim text shown while the field is empty. */
  placeholder?: string;
  /** Return an error message to keep the prompt open, or null when the value is fine. */
  validate?: (value: string) => string | null;
}

export interface InputState {
  value: string;
  /** Caret position, 0..value.length. */
  cursor: number;
}

export type InputResult = 'render' | 'submit' | 'cancel' | 'ignore';

/** Apply one keypress to a text field: typing and paste, arrows, home/end, backspace/delete, ctrl-u/w/a/e. */
export function inputKey(st: InputState, str: string | undefined, key: Key): InputResult {
  const name = key.name;
  if ((key.ctrl && name === 'c') || name === 'escape') return 'cancel';
  if (name === 'return' || name === 'enter') return 'submit';
  const set = (value: string, cursor: number): InputResult => {
    st.value = value;
    st.cursor = cursor;
    return 'render';
  };
  if (name === 'left' || (key.ctrl && name === 'b')) return set(st.value, Math.max(0, st.cursor - 1));
  if (name === 'right' || (key.ctrl && name === 'f')) return set(st.value, Math.min(st.value.length, st.cursor + 1));
  if (name === 'home' || (key.ctrl && name === 'a')) return set(st.value, 0);
  if (name === 'end' || (key.ctrl && name === 'e')) return set(st.value, st.value.length);
  if (name === 'backspace') {
    if (st.cursor === 0) return 'ignore';
    return set(st.value.slice(0, st.cursor - 1) + st.value.slice(st.cursor), st.cursor - 1);
  }
  if (name === 'delete' || (key.ctrl && name === 'd')) {
    if (st.cursor >= st.value.length) return 'ignore';
    return set(st.value.slice(0, st.cursor) + st.value.slice(st.cursor + 1), st.cursor);
  }
  if (key.ctrl && name === 'u') return set(st.value.slice(st.cursor), 0);
  if (key.ctrl && name === 'k') return set(st.value.slice(0, st.cursor), st.cursor);
  if (key.ctrl && name === 'w') {
    const head = st.value.slice(0, st.cursor).replace(/\s*\S*$/, '');
    return set(head + st.value.slice(st.cursor), head.length);
  }
  if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) {
    return set(st.value.slice(0, st.cursor) + str + st.value.slice(st.cursor), st.cursor + str.length);
  }
  return 'ignore';
}

/** The prompt line (plus an error line when there is one), cut to the terminal width around the caret. */
export function renderInput(question: string, st: InputState, c: Palette, cols: number, opts: { placeholder?: string; error?: string | null } = {}): string[] {
  const head = `${c.boldBrand('?')} ${c.bold(question)} `;
  const room = Math.max(8, cols - 1 - stripAnsi(head).length - 1);
  // Scroll the visible window so the caret stays in view.
  const start = Math.max(0, Math.min(st.cursor - room + 1, st.value.length - room + 1));
  const shown = st.value.slice(start, start + room);
  const at = st.cursor - start;
  let body: string;
  if (!st.value && opts.placeholder) {
    body = `${c.inverse(opts.placeholder[0] ?? ' ')}${c.dim(opts.placeholder.slice(1, room))}`;
  } else {
    body = `${c.cyan(shown.slice(0, at))}${c.inverse(shown[at] ?? ' ')}${c.cyan(shown.slice(at + 1))}`;
  }
  const lines = [head + body];
  if (opts.error) lines.push(`  ${c.red('✘')} ${opts.error}`);
  return lines.map((l) => fitLine(l, Math.max(20, cols - 1)));
}

/**
 * Single-line text input on stderr. Resolves with the entered text (trimmed), or null when
 * cancelled or there is no terminal. Callers fall back to flags or defaults without a terminal.
 */
export async function ask(question: string, opts: AskOptions = {}): Promise<string | null> {
  const stream = process.stderr;
  const c = err();
  if (!process.stdin.isTTY || !stream.isTTY) return null;
  return new Promise((resolve) => {
    const st: InputState = { value: opts.initial ?? '', cursor: (opts.initial ?? '').length };
    let error: string | null = null;
    let drawn = 0;
    const clear = () => {
      if (drawn > 0) stream.write(`\r\x1b[${drawn}A\x1b[J`);
      drawn = 0;
    };
    const render = () => {
      const lines = renderInput(question, st, c, stream.columns || 80, { ...(opts.placeholder ? { placeholder: opts.placeholder } : {}), error });
      clear();
      stream.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };
    const finish = (value: string | null) => {
      stop();
      stream.removeListener('resize', render);
      clear();
      if (value !== null) stream.write(fitLine(`${c.boldBrand('?')} ${c.bold(question)} ${value ? c.cyan(value) : c.dim(opts.placeholder ?? '')}`, (stream.columns || 80) - 1) + '\n');
      resolve(value);
    };
    const stop = listenKeys((str, key) => {
      const before = st.value;
      const r = inputKey(st, str, key);
      if (r === 'cancel') return finish(null);
      if (r === 'submit') {
        const value = st.value.trim();
        const problem = opts.validate?.(value) ?? null;
        if (problem) {
          error = problem;
          return render();
        }
        return finish(value);
      }
      if (r === 'render') {
        if (st.value !== before) error = null;
        render();
      }
    }, stream);
    stream.on('resize', render);
    render();
  });
}

export interface Reporter {
  ok(msg: string): void;
  warn(msg: string): void;
  fail(msg: string): void;
  info(msg: string): void;
  step(msg: string): void;
}

/** Status-line printer used by doctor, setup and update. Writes to stdout. */
export function reporter(c: Palette = out()): Reporter {
  const line = (s: string) => process.stdout.write(s + '\n');
  return {
    // Messages are plain text here: a standalone `pf` in them is painted red.
    ok: (m) => line(`  ${c.green('✔')} ${redPf(m, '', c.on)}`),
    warn: (m) => line(`  ${c.yellow('!')} ${redPf(m, '', c.on)}`),
    fail: (m) => line(`  ${c.red('✘')} ${redPf(m, '', c.on)}`),
    info: (m) => line(`    ${c.dim(m)}`),
    step: (m) => line(`\n${c.bold(m)}`),
  };
}
