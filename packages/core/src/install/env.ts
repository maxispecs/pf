import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_NAME, REGISTRY_HOST } from '@pulpfixer/kit/constants';
import { capture } from '@pulpfixer/kit/exec';
import { readJson, whichAll } from '@pulpfixer/kit/util';

export interface PfInstall {
  /** Path as found on PATH. */
  path: string;
  /** Symlink-resolved path. */
  real: string;
  /** Version of the pulpfixer package it belongs to, when it can be read. */
  version?: string;
  legacy: boolean;
}

export function majorOf(v: string | undefined): number {
  return parseInt((v ?? '').split('.')[0] ?? '', 10) || 0;
}

/** Version of the pulpfixer package that owns a file, found by walking up to its package.json. */
export function packageVersionOf(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const pkg = readJson<{ name?: string; version?: string }>(dir, 'package.json');
    if (pkg?.name === PACKAGE_NAME) return pkg.version;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Every `pf` on PATH, with legacy (pulpfixer < 2) ones flagged. */
export function pfOnPath(): PfInstall[] {
  return whichAll('pf').map((p) => {
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      // dangling link: keep the path
    }
    const version = packageVersionOf(real);
    return { path: p, real, ...(version ? { version } : {}), legacy: version !== undefined && majorOf(version) < 2 };
  });
}

export function npmGlobalRoot(): string | null {
  const r = capture(['npm', 'root', '-g'], { timeout: 15_000 });
  const line = r.stdout.trim().split('\n').pop()?.trim();
  return r.ok && line ? line : null;
}

export function npmGlobalPrefix(): string | null {
  const r = capture(['npm', 'prefix', '-g'], { timeout: 15_000 });
  const line = r.stdout.trim().split('\n').pop()?.trim();
  return r.ok && line ? line : null;
}

/** The legacy global `pulpfixer` (< 2.0) package, if installed. */
export function legacyGlobal(): { dir: string; version: string } | null {
  const root = npmGlobalRoot();
  if (!root) return null;
  const dir = path.join(root, PACKAGE_NAME);
  const v = readJson<{ version?: string }>(dir, 'package.json')?.version;
  return v && majorOf(v) < 2 ? { dir, version: v } : null;
}

/** Is the npm global bin directory on PATH? */
export function globalBinOnPath(): { ok: boolean; bin: string | null } {
  const prefix = npmGlobalPrefix();
  if (!prefix) return { ok: false, bin: null };
  const bin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return { ok: dirs.includes(bin), bin };
}

export function userNpmrc(): string {
  return process.env.NPM_CONFIG_USERCONFIG ?? path.join(os.homedir(), '.npmrc');
}

/** Does the user's .npmrc carry an auth line for the cellars registry? Never reads the token itself. */
export function npmrcHasCellarsAuth(file = userNpmrc()): boolean {
  try {
    const re = new RegExp(`^//${REGISTRY_HOST.replace(/\./g, '\\.')}/:_authToken=`, 'm');
    return re.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}
