import fs from 'node:fs';
import path from 'node:path';

export function exists(...parts: string[]): boolean {
  return fs.existsSync(path.join(...parts));
}

export function readText(...parts: string[]): string | null {
  try {
    return fs.readFileSync(path.join(...parts), 'utf8');
  } catch {
    return null;
  }
}

export function readJson<T = Record<string, unknown>>(...parts: string[]): T | null {
  const text = readText(...parts);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Find an executable on PATH. */
export function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Every match of a bin on PATH, in order (like `which -a`). */
export function whichAll(bin: string): string[] {
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (!out.includes(p)) out.push(p);
    } catch {
      // keep looking
    }
  }
  return out;
}

export function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Compare dotted numeric versions: returns -1, 0 or 1. Prerelease tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('-')[0]!.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Remove one flag from args, returning whether it was present. */
export function takeFlag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (let i = args.length - 1; i >= 0; i--) {
    if (names.includes(args[i]!)) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

/** Remove `--name value` or `--name=value` from args, returning the value. */
export function takeOption(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      args.splice(i, 2);
      return value;
    }
    if (a.startsWith(`${name}=`)) {
      args.splice(i, 1);
      return a.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Split args at the first `--`: [before, after]. */
export function splitDashes(args: string[]): [string[], string[]] {
  const i = args.indexOf('--');
  return i === -1 ? [args, []] : [args.slice(0, i), args.slice(i + 1)];
}
