import { spawnSync } from 'node:child_process';
import { which } from '@pulpfixer/kit/util';

/** Which YubiKey to talk to. Without a serial ykman uses the only key plugged in. */
export interface YkTarget {
  device?: string;
}

export const hasYkman = (): boolean => which('ykman') !== null;

export const YKMAN_INSTALL = 'brew install ykman (macOS), pipx install yubikey-manager, or https://docs.yubico.com/software/yubikey/tools/ykman/Install_ykman.html';

/** `ykman [--device <serial>] <args>`. */
export function ykArgv(args: string[], t: YkTarget = {}): string[] {
  return ['ykman', ...(t.device ? ['--device', t.device] : []), ...args];
}

/** `ykman oath accounts list`: account names only, no codes. */
export function accountsArgv(t: YkTarget, o: { hidden?: boolean } = {}): string[] {
  return ykArgv(['oath', 'accounts', 'list', ...(o.hidden ? ['-H'] : [])], t);
}

/**
 * `ykman oath accounts code`. `single` makes ykman print only the code and fail unless exactly one
 * account matches. The query follows `--` so a name starting with a dash is not read as an option.
 */
export function codeArgv(t: YkTarget, o: { query?: string; single?: boolean; hidden?: boolean } = {}): string[] {
  return ykArgv(['oath', 'accounts', 'code', ...(o.single ? ['-s'] : []), ...(o.hidden ? ['-H'] : []), ...(o.query ? ['--', o.query] : [])], t);
}

export interface YkRun {
  ok: boolean;
  /** Exit code; 127 when ykman is missing, 124 on timeout. */
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run ykman and capture stdout. With `interactive`, stdin and stderr stay on the terminal so ykman
 * can ask for the OATH password and say "touch your YubiKey"; otherwise stdin is closed, stderr is
 * captured and the call gives up after 30 seconds.
 */
export function ykRun(argv: string[], o: { interactive?: boolean } = {}): YkRun {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: o.interactive ? ['inherit', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    ...(o.interactive ? {} : { timeout: 30_000 }),
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, status: 127, stdout: '', stderr: 'ykman not found on PATH' };
    if (code === 'ETIMEDOUT') return { ok: false, status: 124, stdout: '', stderr: 'ykman timed out' };
    return { ok: false, status: 1, stdout: '', stderr: r.error.message };
  }
  const status = r.status ?? 1;
  return { ok: status === 0, status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The line that says what went wrong: the first ERROR line, else the last line that is not a warning. */
export function ykError(r: YkRun): string {
  const lines = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const real = lines.find((l) => /^(error|failed)/i.test(l));
  if (real) return real.replace(/^error:\s*/i, '');
  return [...lines].reverse().find((l) => !/^warning/i.test(l)) ?? `ykman exited with ${r.status}`;
}

/** Account names from `ykman oath accounts list`, one per line. */
export function parseAccounts(stdout: string): string[] {
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** A TOTP/HOTP code: 6 to 8 digits, or the 5 letters of a Steam code. */
export const isCode = (s: string): boolean => /^(\d{6,8}|[0-9A-Z]{5})$/.test(s);

// ---- clipboard ----

/** Clipboard programs to try, best first, for a platform. */
export function clipboardTools(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[][] {
  if (platform === 'darwin') return [['pbcopy']];
  if (platform === 'win32') return [['clip']];
  const tools = [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
  return env.WAYLAND_DISPLAY ? [['wl-copy'], ...tools] : [...tools, ['wl-copy']];
}

/** Put text on the clipboard. Returns the program that did it, or null when none is available. */
export function copyText(text: string, tools: string[][] = clipboardTools(), has: (bin: string) => boolean = (b) => which(b) !== null): string | null {
  for (const argv of tools) {
    if (!has(argv[0]!)) continue;
    const r = spawnSync(argv[0]!, argv.slice(1), { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5_000 });
    if (!r.error && r.status === 0) return argv[0]!;
  }
  return null;
}
