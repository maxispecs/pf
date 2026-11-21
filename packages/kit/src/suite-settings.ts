import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginSettings, savePluginSettings } from './plugin-settings.js';

/**
 * Settings of the pulpfixer suite (`pf suite config`). They are user settings: `plugins.suite` in `~/.pf/config.json`.
 * They live in kit because core (`pf template apply`) and the workbench scripts read them, and kit depends on nothing.
 * A new setting is one entry in `SUITE_SETTINGS`.
 */
export const SUITE_SETTINGS_NAME = 'suite';

export type Normalized = { value: string } | { error: string };

export interface SettingDef {
  key: string;
  description: string;
  /** The default, as it is shown and stored (`~/dev`). */
  default: string;
  /** Environment variable that overrides the saved value (tests, one-off runs). */
  env?: string;
  /** Check a value the user typed; returns what to store, or why it cannot be used. */
  normalize(value: string): Normalized;
  /** The value as a program uses it (`~/dev` -> `/Users/me/dev`). Defaults to the value itself. */
  resolve?(value: string): string;
}

/** `~` or `~/x` -> the home folder; anything else is returned as it is. */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** The reverse, for showing a path: the home folder becomes `~`. */
export function shortHome(p: string, home: string = os.homedir()): string {
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${path.sep}${p.slice(home.length + 1)}` : p;
}

function normalizeDir(raw: string): Normalized {
  const text = raw.trim();
  if (!text) return { error: 'a folder is needed' };
  if (text.includes('\0')) return { error: 'that is not a folder path' };
  if (text.startsWith('~') && text !== '~' && !text.startsWith('~/') && !text.startsWith('~\\')) {
    return { error: `${text}: only ~ and ~/<folder> are understood (not ~user)` };
  }
  const abs = expandHome(text);
  if (!path.isAbsolute(abs)) return { error: `${text} is not an absolute path (start with / or ~/)` };
  try {
    if (!fs.statSync(abs).isDirectory()) return { error: `${abs} exists and is not a folder` };
  } catch {
    // it does not exist yet: it is created the first time a repo is made there
  }
  // keep `~` in what is stored, so the config file works on another machine too
  const stored = text.startsWith('~') ? text.replace(/[\\/]+$/, '') || '~' : path.resolve(abs);
  return { value: stored };
}

export const SUITE_SETTINGS: Record<string, SettingDef> = {
  reposDir: {
    key: 'reposDir',
    description: 'Folder where new repos are created (templates: query, pipe and IO adapter packages; pf wb-promote --repo)',
    default: '~/dev',
    env: 'PF_REPOS_DIR',
    normalize: normalizeDir,
    resolve: (v) => expandHome(v),
  },
};

export const SUITE_SETTING_KEYS: string[] = Object.keys(SUITE_SETTINGS);

export type SettingSource = 'env' | 'config' | 'default';

export interface SettingValue {
  key: string;
  description: string;
  /** What is in effect, as written (`~/dev`). */
  value: string;
  /** The same, as a program uses it (an absolute path for a folder). */
  resolved: string;
  default: string;
  source: SettingSource;
}

/** The value in effect for one setting: the environment, then the saved value, then the default. A bad saved value is ignored. */
export function suiteSetting(key: string): SettingValue | undefined {
  const def = Object.hasOwn(SUITE_SETTINGS, key) ? SUITE_SETTINGS[key] : undefined;
  if (!def) return undefined;
  const base = { key: def.key, description: def.description, default: def.default };
  const make = (value: string, source: SettingSource): SettingValue => ({ ...base, value, resolved: def.resolve ? def.resolve(value) : value, source });
  const fromEnv = def.env ? process.env[def.env] : undefined;
  if (fromEnv) {
    const n = def.normalize(fromEnv);
    if ('value' in n) return make(n.value, 'env');
  }
  const saved = pluginSettings(SUITE_SETTINGS_NAME)[key];
  if (typeof saved === 'string') {
    const n = def.normalize(saved);
    if ('value' in n) return make(n.value, 'config');
  }
  return make(def.default, 'default');
}

export function suiteSettings(): SettingValue[] {
  return SUITE_SETTING_KEYS.map((k) => suiteSetting(k)!);
}

export type SettingWrite = { ok: true; value: string } | { ok: false; kind: 'unknown' | 'invalid' | 'save'; error: string };

const unknownKey = (key: string): SettingWrite => ({ ok: false, kind: 'unknown', error: `no suite setting "${key}" (${SUITE_SETTING_KEYS.join(', ')})` });

/** Save a setting. The value is checked first; other keys of `config.json` are kept. */
export function setSuiteSetting(key: string, raw: string): SettingWrite {
  const def = Object.hasOwn(SUITE_SETTINGS, key) ? SUITE_SETTINGS[key] : undefined;
  if (!def) return unknownKey(key);
  const n = def.normalize(raw);
  if ('error' in n) return { ok: false, kind: 'invalid', error: n.error };
  if (!savePluginSettings(SUITE_SETTINGS_NAME, { [key]: n.value })) return { ok: false, kind: 'save', error: 'could not write the pf config (is the pf home read-only?)' };
  return { ok: true, value: n.value };
}

/** Remove a saved setting, so the default applies again. */
export function unsetSuiteSetting(key: string): SettingWrite {
  const def = Object.hasOwn(SUITE_SETTINGS, key) ? SUITE_SETTINGS[key] : undefined;
  if (!def) return unknownKey(key);
  if (!savePluginSettings(SUITE_SETTINGS_NAME, { [key]: undefined })) return { ok: false, kind: 'save', error: 'could not write the pf config (is the pf home read-only?)' };
  return { ok: true, value: def.default };
}

/** The folder new repos are created in, as an absolute path. */
export function reposDir(): string {
  return suiteSetting('reposDir')!.resolved;
}

const PLAIN_NAME = /^(?!\.{1,2}$)[^/\\\0]+$/;

/** Where a new repo called `name` goes: `<reposDir>/<name>`. The name must be one plain folder name. */
export function newRepoPath(name: string): { path: string } | { error: string } {
  if (!PLAIN_NAME.test(name)) return { error: `"${name}" is not one folder name` };
  return { path: path.join(reposDir(), name) };
}
