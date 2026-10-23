import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_NAME } from './constants.js';

let appRoot: string | null = null;

/** The entry package registers its own directory at startup (see `src/bin/pf.ts`). */
export function setPackageRoot(dir: string): void {
  appRoot = dir;
}

/** Directory of the pf package (holds `assets/`, `scripts/`, `dist/`), found from the entry script when not registered. */
export function packageRoot(): string {
  if (appRoot) return appRoot;
  const entry = process.argv[1];
  let dir = entry ? path.dirname(fs.realpathSync(entry)) : process.cwd();
  for (;;) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string };
        if (pkg.name === PACKAGE_NAME) return dir;
      } catch {
        // fall through
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 2.1.0 -> "2.1" (versions are major.minor; a patch is shown only when it is set). */
export function displayVersion(v: string = version()): string {
  return v.endsWith('.0') ? v.slice(0, -2) : v;
}
