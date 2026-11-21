import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from '@pulpfixer/kit/exec';
import { readText } from '@pulpfixer/kit/util';

/** A vault Obsidian knows about (its own `obsidian.json`). */
export interface Vault {
  id: string;
  path: string;
  /** Open in Obsidian right now. */
  open: boolean;
  /** The folder is still there. */
  exists: boolean;
  /** It has a `.obsidian` folder (Obsidian made one when the vault was first opened). */
  configured: boolean;
}

/** Obsidian's own settings folder for a platform (it holds `obsidian.json`, the vault list). `PF_OBSIDIAN_DIR` overrides it (tests, portable installs). */
export function obsidianConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (env.PF_OBSIDIAN_DIR) return env.PF_OBSIDIAN_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'obsidian');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'obsidian');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'obsidian');
}

export const obsidianJsonPath = (dir: string = obsidianConfigDir()): string => path.join(dir, 'obsidian.json');

/** Obsidian seems to be installed here: it has made its settings folder. */
export const detectObsidian = (dir: string = obsidianConfigDir()): boolean => fs.existsSync(dir);

/** The vaults in an `obsidian.json` text, in the order the file lists them; null when it is not the expected JSON. */
export function parseVaultList(text: string): { id: string; path: string; open: boolean }[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const vaults = (raw as { vaults?: unknown } | null)?.vaults;
  if (!vaults || typeof vaults !== 'object' || Array.isArray(vaults)) return null;
  const found: { id: string; path: string; open: boolean }[] = [];
  for (const [id, v] of Object.entries(vaults as Record<string, unknown>)) {
    const x = v as { path?: unknown; open?: unknown } | null;
    if (!x || typeof x.path !== 'string' || !path.isAbsolute(x.path)) continue;
    found.push({ id, path: x.path, open: x.open === true });
  }
  return found;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export interface VaultList {
  file: string;
  /** `obsidian.json` was found and readable. */
  found: boolean;
  vaults: Vault[];
  problem?: string;
}

/** The vaults Obsidian lists, with whether each is still on disk. Reads files only. */
export function listVaults(dir: string = obsidianConfigDir()): VaultList {
  const file = obsidianJsonPath(dir);
  const text = readText(file);
  if (text === null) return { file, found: false, vaults: [], problem: `${file} not found (has Obsidian been opened on this machine?)` };
  const parsed = parseVaultList(text);
  if (!parsed) return { file, found: false, vaults: [], problem: `${file} is not a vault list` };
  return {
    file,
    found: true,
    vaults: parsed.map((v) => ({ ...v, exists: isDir(v.path), configured: isDir(path.join(v.path, '.obsidian')) })),
  };
}

/**
 * Turn a `--vault` value into a vault path: an absolute path, or the name of exactly one known vault (its folder name).
 * The folder must exist and hold a `.obsidian` folder. Returns the path, or why it cannot be used.
 */
export function resolveVault(input: string, known: Vault[], cwd: string = process.cwd()): { path: string } | string {
  if (!input.trim()) return '--vault needs a path or a vault name';
  const named = !input.includes('/') && !input.includes('\\') && !input.startsWith('.') && !input.startsWith('~');
  let target = input;
  if (named) {
    const hits = known.filter((v) => path.basename(v.path).toLowerCase() === input.toLowerCase());
    if (hits.length > 1) return `"${input}" matches more than one vault (${hits.map((h) => h.path).join(', ')}): pass the path`;
    if (hits.length === 1) target = hits[0]!.path;
  }
  if (target.startsWith('~')) target = path.join(os.homedir(), target.slice(1));
  const abs = path.resolve(cwd, target);
  if (!isDir(abs)) return `${abs} is not a folder`;
  if (!isDir(path.join(abs, '.obsidian'))) return `${abs} has no .obsidian folder: open it once in Obsidian first`;
  return { path: fs.realpathSync(abs) };
}

/** Is Obsidian running? A failed probe counts as "no": this only decides a warning. */
export function obsidianRunning(platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === 'win32') return /Obsidian\.exe/i.test(capture(['tasklist', '/FI', 'IMAGENAME eq Obsidian.exe', '/NH']).stdout);
    return capture(['pgrep', '-xi', 'obsidian']).ok;
  } catch {
    return false;
  }
}
