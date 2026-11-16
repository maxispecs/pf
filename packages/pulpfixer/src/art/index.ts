import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from '@pulpfixer/kit/constants';
import { renderMascot, mascotSize, type MascotName } from '@pulpfixer/kit/ui/mascot';
import { halfBlocks } from '@pulpfixer/kit/ui/lost';
import { out } from '@pulpfixer/kit/ui/palette';
import { stripAnsi } from '@pulpfixer/kit/ui/palette';
import { readJson } from '@pulpfixer/kit/util';
import { packageRoot } from '@pulpfixer/kit/version';

/** The built-in octopuses, by the names art.json uses. */
export const BUILTIN_ARTS: Record<string, MascotName> = {
  'octopus-repo': 'repo',
  'octopus-update': 'update',
  'octopus-agent': 'agent',
};

/** Arguments that mean a command is not doing its usual job, so its picture stays away. */
const QUIET_ARGS: Record<string, string[]> = { update: ['--repo-only'], agent: ['use'] };

/** Folders with art.json and .ansi files: yours first (`~/.pf/art`), then the ones that ship with pf. */
export function artDirs(): string[] {
  return [path.join(pfHome(), 'art'), path.join(packageRoot(), 'assets', 'art')];
}

/** command -> picture name (`none` hides it). Yours merge over the shipped ones. */
export function artActions(dirs = artDirs()): Record<string, string> {
  const actions: Record<string, string> = {};
  for (const dir of [...dirs].reverse()) {
    const cfg = readJson<{ actions?: Record<string, unknown> }>(dir, 'art.json');
    for (const [cmd, art] of Object.entries(cfg?.actions ?? {})) if (typeof art === 'string') actions[cmd] = art;
  }
  return actions;
}

/** The .ansi file for a picture name, looking in your folder first. */
export function ansiFile(name: string, dirs = artDirs()): string | null {
  if (!/^[\w.-]+$/.test(name)) return null;
  for (const dir of dirs) {
    const p = path.join(dir, `${name}.ansi`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Every .ansi picture in the folders, name -> file (yours win). */
export function customArts(dirs = artDirs()): Record<string, string> {
  const found: Record<string, string> = {};
  for (const dir of [...dirs].reverse()) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) if (f.endsWith('.ansi')) found[f.slice(0, -5)] = path.join(dir, f);
  }
  return found;
}

/** An .ansi file reduced to what is safe to print: color escapes only, reset at the end of every line. */
export function cleanAnsi(text: string): string[] {
  const any = /\x1b\[[0-9;]*m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.?|[\x00-\x08\x0b-\x1f\x7f]/g;
  const lines = text.replace(/\r/g, '').replace(any, (m) => (/^\x1b\[[0-9;]*m$/.test(m) ? m : '')).split('\n');
  while (lines.length && !stripAnsi(lines[lines.length - 1]!).trim()) lines.pop();
  return lines.map((l) => `${l}\x1b[0m`);
}

/** Size of an .ansi picture in characters. */
export function ansiSize(lines: string[]): { width: number; height: number } {
  return { width: Math.max(0, ...lines.map((l) => stripAnsi(l).length)), height: lines.length };
}

/** The picture for a command as lines to print, or null when there is none, it is off, or the file is missing. */
export function artFor(command: string, dirs = artDirs()): { lines: string[]; width: number; height: number } | null {
  const name = artActions(dirs)[command];
  if (!name || name === 'none') return null;
  const builtin = BUILTIN_ARTS[name];
  if (builtin) {
    const text = renderMascot(builtin, out());
    const size = mascotSize(halfBlocks());
    return text ? { lines: text.split('\n'), ...size, height: size.height + 1 } : null;
  }
  const file = ansiFile(name, dirs);
  if (!file) return null;
  const lines = cleanAnsi(fs.readFileSync(file, 'utf8'));
  return lines.length ? { lines: ['', ...lines.map((l) => `  ${l}`)], ...ansiSize(lines), height: lines.length + 1 } : null;
}

/** Print a command's picture to stderr, only on a color terminal big enough for it (never into logs or pipes). */
export function printActionArt(command: string, args: string[] = []): void {
  if (process.env.PF_NO_TRAVOLTA || process.env.PF_NO_MASCOT || !process.stderr.isTTY || !out().on) return;
  if (QUIET_ARGS[command]?.some((a) => args.includes(a))) return;
  const art = artFor(command);
  if (!art) return;
  if ((process.stderr.columns ?? 0) < art.width + 3 || (process.stderr.rows ?? 0) < art.height + 6) return;
  process.stderr.write(art.lines.join('\n') + '\n');
}
