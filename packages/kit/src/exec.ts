import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { err } from './ui/palette.js';
import { badge, term, termLine } from './ui/text.js';
import { quote } from './util.js';

export interface Cmd {
  /** argv, or a single shell line when `shell` is true. */
  argv: string[];
  cwd?: string;
  shell?: boolean;
}

export function shellCmd(line: string, cwd?: string): Cmd {
  return cwd ? { argv: [line], shell: true, cwd } : { argv: [line], shell: true };
}

/** Printable form: `pnpm run dev` (with `(in apps/docs)` when cwd differs from base). */
export function formatCmd(cmd: Cmd, base?: string): string {
  const line = cmd.shell ? cmd.argv[0]! : cmd.argv.map(quote).join(' ');
  if (cmd.cwd && base && path.resolve(cmd.cwd) !== path.resolve(base)) {
    return `${line}  (in ${path.relative(base, cmd.cwd) || '.'})`;
  }
  return line;
}

/** Append user args to a command. */
export function withArgs(cmd: Cmd, extra: string[]): Cmd {
  if (extra.length === 0) return cmd;
  if (cmd.shell) return { ...cmd, argv: [`${cmd.argv[0]} ${extra.map(quote).join(' ')}`] };
  return { ...cmd, argv: [...cmd.argv, ...extra] };
}

export interface RunOptions {
  dryRun?: boolean;
  /** Directory the command's cwd is shown relative to. */
  base?: string;
  env?: NodeJS.ProcessEnv;
  /** Do not echo the command line. */
  quiet?: boolean;
}

/** Run a command with inherited stdio. Resolves with the exit code. */
export function runCmd(cmd: Cmd, opts: RunOptions = {}): Promise<number> {
  const c = err();
  if (!opts.quiet || opts.dryRun) {
    const line = termLine(formatCmd(cmd, opts.base), c);
    process.stderr.write(`${opts.dryRun ? `${c.dim('would run')} ${line}` : `${term(c).prefix()}${line}`}\n`);
  }
  if (opts.dryRun) return Promise.resolve(0);
  return new Promise((resolve) => {
    const child = cmd.shell
      ? spawn(cmd.argv[0]!, { cwd: cmd.cwd, stdio: 'inherit', shell: true, env: opts.env ?? process.env })
      : spawn(cmd.argv[0]!, cmd.argv.slice(1), { cwd: cmd.cwd, stdio: 'inherit', env: opts.env ?? process.env });
    // Let the child own Ctrl-C; pf exits with the child's status.
    const ignore = () => undefined;
    process.on('SIGINT', ignore);
    child.on('error', (e: NodeJS.ErrnoException) => {
      process.removeListener('SIGINT', ignore);
      process.stderr.write(`${badge.error(e.code === 'ENOENT' ? `${cmd.argv[0]} not found on PATH` : e.message, c)}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', ignore);
      resolve(code ?? (signal ? 130 : 1));
    });
  });
}

export interface CaptureResult {
  /** Exit code; 124 on timeout, 127 when the binary is missing. */
  code: number;
  /** stdout and stderr interleaved, trimmed to the last `maxBytes` characters. */
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Run a command with piped output (never touches this process's stdout) and resolve with the
 * exit code and the tail of its output. stdin is closed, so prompts fail instead of hanging.
 */
export function captureAsync(
  cmd: Cmd,
  opts: { timeout?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CaptureResult> {
  const max = opts.maxBytes ?? 20_000;
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > max * 2) {
        output = output.slice(-max);
        truncated = true;
      }
    };
    const child = cmd.shell
      ? spawn(cmd.argv[0]!, { cwd: cmd.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env })
      : spawn(cmd.argv[0]!, cmd.argv.slice(1), { cwd: cmd.cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout!.on('data', append);
    child.stderr!.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeout ?? 10 * 60_000);
    const finish = (code: number) => {
      clearTimeout(timer);
      if (output.length > max) {
        output = output.slice(-max);
        truncated = true;
      }
      resolve({ code, output, truncated, timedOut });
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      output += e.code === 'ENOENT' ? `${cmd.argv[0]} not found on PATH\n` : `${e.message}\n`;
      finish(127);
    });
    child.on('close', (code, signal) => finish(timedOut ? 124 : (code ?? (signal ? 130 : 1))));
  });
}

/** Run a command and capture its output (no terminal). */
export function capture(
  argv: string[],
  opts: { cwd?: string; timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  try {
    const r = spawnSync(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout ?? 30_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e), status: null };
  }
}
