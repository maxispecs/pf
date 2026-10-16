import readline from 'node:readline';
import { err, out, type Palette } from './palette.js';

/** Yes/no question. Returns `fallback` without asking when there is no terminal. */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return fallback;
  const c = err();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${c.boldBrand('?')} ${c.bold(question)} ${c.dim('(' + hint + ')')} `, resolve);
  });
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a) return fallback;
  return a === 'y' || a === 'yes';
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
