import type { Key } from 'node:readline';
import { listenKeys } from './keys.js';
import { err, fitLine, out, type Palette } from './palette.js';

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
    ok: (m) => line(`  ${c.green('✔')} ${m}`),
    warn: (m) => line(`  ${c.yellow('!')} ${m}`),
    fail: (m) => line(`  ${c.red('✘')} ${m}`),
    info: (m) => line(`    ${c.dim(m)}`),
    step: (m) => line(`\n${c.bold(m)}`),
  };
}
