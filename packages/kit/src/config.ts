import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from './constants.js';
import { readJson } from './util.js';

export interface CustomCommand {
  run: string;
  description?: string;
  group?: string;
  /** Relative to the repo root. */
  cwd?: string;
}

/** Repo config: `pf.json` at the repo root. */
export interface RepoConfig {
  name?: string;
  commands: Record<string, CustomCommand>;
}

/** User config: `~/.pf/config.json`. */
export interface UserConfig {
  /** Agent CLI used to run prompt-only skills: cursor-agent, claude or codex. Auto-detected when unset. */
  agent?: string;
  /** Extra directories scanned for skills. */
  skillDirs?: string[];
}

export function loadRepoConfig(root: string): RepoConfig {
  const raw = readJson<{ name?: unknown; commands?: unknown }>(root, 'pf.json');
  const commands: Record<string, CustomCommand> = {};
  if (raw && raw.commands && typeof raw.commands === 'object') {
    for (const [name, v] of Object.entries(raw.commands as Record<string, unknown>)) {
      if (typeof v === 'string') {
        commands[name] = { run: v };
      } else if (v && typeof v === 'object' && typeof (v as { run?: unknown }).run === 'string') {
        const o = v as CustomCommand;
        commands[name] = {
          run: o.run,
          ...(typeof o.description === 'string' ? { description: o.description } : {}),
          ...(typeof o.group === 'string' ? { group: o.group } : {}),
          ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
        };
      }
    }
  }
  return { ...(typeof raw?.name === 'string' ? { name: raw.name } : {}), commands };
}

export function userConfigPath(): string {
  return path.join(pfHome(), 'config.json');
}

export function loadUserConfig(): UserConfig {
  return readJson<UserConfig>(userConfigPath()) ?? {};
}

interface History {
  /** Last menu entry run, keyed by repo root. */
  menu?: Record<string, string>;
}

function historyPath(): string {
  return path.join(pfHome(), 'history.json');
}

/** The menu entry this repo ran last, so the menu can start on it. */
export function lastMenuChoice(key: string): string | undefined {
  return readJson<History>(historyPath())?.menu?.[key];
}

/** Remember the menu entry just chosen. Never throws. */
export function rememberMenuChoice(key: string, name: string): void {
  const history = readJson<History>(historyPath()) ?? {};
  writeHomeFile('history.json', JSON.stringify({ ...history, menu: { ...(history.menu ?? {}), [key]: name } }, null, 2) + '\n');
}

/** Write a file under the pf home; returns false (never throws) when the home is read-only. */
export function writeHomeFile(rel: string, content: string): boolean {
  try {
    const p = path.join(pfHome(), rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return true;
  } catch {
    return false;
  }
}
