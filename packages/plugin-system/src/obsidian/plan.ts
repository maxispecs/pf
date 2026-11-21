import fs from 'node:fs';
import path from 'node:path';
import type { Palette } from '@pulpfixer/kit/ui/palette';
import { sameJson } from '../jsonc.js';
import type { ObsidianConfig } from './config.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** One value that changes inside a file: `path` is the key path inside the JSON. */
export interface Change {
  path: string[];
  /** Current value; undefined when the key is not set. */
  from: unknown;
  to: unknown;
}

/** A file in `.obsidian` that applying the preset writes. */
export interface FileChange {
  /** Relative to the `.obsidian` folder (`core-plugins.json`, `plugins/<id>/data.json`). */
  file: string;
  /** The file does not exist yet. */
  isNew: boolean;
  changes: Change[];
  /** The whole file after the change. */
  next: unknown;
}

export interface ObsidianPlan {
  files: FileChange[];
  /** Community plugins the preset wants that are not installed in this vault (not enabled, not configured). */
  missingPlugins: string[];
  /** The theme the preset wants when it is not installed in this vault. */
  missingTheme: string | null;
  /** Values that already match, for the summary line. */
  ok: number;
}

/** The parts of a vault's `.obsidian` folder the plan reads. A file that does not exist is null. */
export interface VaultState {
  app: Json | null;
  appearance: Json | null;
  corePlugins: Json | null;
  communityPlugins: string[] | null;
  hotkeys: Json | null;
  /** Plugins with a `manifest.json` in `plugins/<id>`, and their `data.json`. */
  plugins: Record<string, { data: Json | null }>;
  /** Themes with a `theme.css` in `themes/<name>`. */
  themes: string[];
  /** Files that exist but cannot be used (not JSON objects): applying is refused. */
  problems: string[];
}

function readFileJson(file: string, problems: string[], rel: string): unknown | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    problems.push(`${rel} is not valid JSON (fix it by hand first, nothing was changed)`);
    return null;
  }
}

/** Read what a vault has now. `want` limits the plugin folders that are read. */
export function readVault(vault: string, want: ObsidianConfig): VaultState {
  const dir = path.join(vault, '.obsidian');
  const problems: string[] = [];
  const object = (rel: string): Json | null => {
    const v = readFileJson(path.join(dir, rel), problems, rel);
    if (v === null) return null;
    if (!isObject(v)) {
      problems.push(`${rel} is not a JSON object (fix it by hand first, nothing was changed)`);
      return null;
    }
    return v;
  };
  const list = (rel: string): string[] | null => {
    const v = readFileJson(path.join(dir, rel), problems, rel);
    if (v === null) return null;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      problems.push(`${rel} is not a JSON array of plugin ids (fix it by hand first, nothing was changed)`);
      return null;
    }
    return v as string[];
  };

  const plugins: VaultState['plugins'] = {};
  for (const id of new Set([...want.communityPlugins, ...Object.keys(want.pluginSettings)])) {
    const pdir = path.join(dir, 'plugins', id);
    if (!fs.existsSync(path.join(pdir, 'manifest.json'))) continue;
    const rel = `plugins/${id}/data.json`;
    const data = readFileJson(path.join(dir, rel), problems, rel);
    if (data !== null && !isObject(data)) problems.push(`${rel} is not a JSON object (fix it by hand first, nothing was changed)`);
    plugins[id] = { data: isObject(data) ? data : null };
  }
  const theme = want.appearance.cssTheme;
  const themes = typeof theme === 'string' && theme && fs.existsSync(path.join(dir, 'themes', theme, 'theme.css')) ? [theme] : [];

  return {
    app: object('app.json'),
    appearance: object('appearance.json'),
    corePlugins: object('core-plugins.json'),
    communityPlugins: list('community-plugins.json'),
    hotkeys: object('hotkeys.json'),
    plugins,
    themes,
    problems,
  };
}

/** The leaf changes that make `current` hold everything in `desired` (other keys are left alone). */
export function diffObject(current: Json | null, desired: Json, prefix: string[] = []): { changes: Change[]; ok: number } {
  const changes: Change[] = [];
  let ok = 0;
  for (const [key, to] of Object.entries(desired)) {
    const has = current !== null && Object.prototype.hasOwnProperty.call(current, key);
    const from = has ? current![key] : undefined;
    if (isObject(to) && isObject(from)) {
      const inner = diffObject(from, to, [...prefix, key]);
      changes.push(...inner.changes);
      ok += inner.ok;
    } else if (from !== undefined && sameJson(from, to)) ok++;
    else changes.push({ path: [...prefix, key], from, to });
  }
  return { changes, ok };
}

/** `current` with the changes set, as a copy. */
export function applyChanges(current: Json | null, changes: Change[]): Json {
  const next = structuredClone(current ?? {}) as Json;
  for (const ch of changes) {
    let at = next;
    for (const k of ch.path.slice(0, -1)) {
      const inner = at[k];
      if (!isObject(inner)) at[k] = {};
      at = at[k] as Json;
    }
    at[ch.path[ch.path.length - 1]!] = structuredClone(ch.to);
  }
  return next;
}

/**
 * What applying an Obsidian preset to a vault would change. Additive: a value the preset names is set when it differs,
 * the plugins list only grows, other keys stay. A community plugin is enabled and configured only when the vault has
 * it installed, and a theme is set only when it is installed; pf never installs either.
 */
export function planObsidian(cfg: ObsidianConfig, state: VaultState): ObsidianPlan {
  const files: FileChange[] = [];
  let ok = 0;
  const fileChange = (file: string, current: unknown, desired: Json): void => {
    const d = diffObject(isObject(current) ? current : null, desired);
    ok += d.ok;
    if (d.changes.length) files.push({ file, isNew: current === null, changes: d.changes, next: applyChanges(isObject(current) ? current : null, d.changes) });
  };

  fileChange('app.json', state.app, cfg.app);

  const appearance: Json = { ...cfg.appearance };
  const wantedTheme = typeof appearance.cssTheme === 'string' && appearance.cssTheme ? appearance.cssTheme : null;
  const missingTheme = wantedTheme !== null && !state.themes.includes(wantedTheme) ? wantedTheme : null;
  if (missingTheme !== null) delete appearance.cssTheme;
  fileChange('appearance.json', state.appearance, appearance);

  fileChange('core-plugins.json', state.corePlugins, cfg.corePlugins);

  const missing: string[] = [];
  const enabled = state.communityPlugins ?? [];
  const added: string[] = [];
  for (const id of cfg.communityPlugins) {
    if (!(id in state.plugins)) {
      missing.push(id);
      continue;
    }
    if (enabled.includes(id)) ok++;
    else added.push(id);
  }
  if (added.length) {
    files.push({
      file: 'community-plugins.json',
      isNew: state.communityPlugins === null,
      changes: added.map((id) => ({ path: [id], from: undefined, to: 'enabled' })),
      next: [...enabled, ...added],
    });
  }

  const hotkeys: Json = {};
  for (const [cmd, keys] of Object.entries(cfg.hotkeys)) hotkeys[cmd] = keys;
  fileChange('hotkeys.json', state.hotkeys, hotkeys);

  for (const [id, settings] of Object.entries(cfg.pluginSettings)) {
    const have = state.plugins[id];
    if (!have) {
      if (!missing.includes(id)) missing.push(id);
      continue;
    }
    fileChange(`plugins/${id}/data.json`, have.data, settings);
  }

  return { files, missingPlugins: missing, missingTheme, ok };
}

export const isEmptyObsidianPlan = (p: ObsidianPlan): boolean => p.files.length === 0;

const show = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

/** Human lines for a plan, for apply and --dry-run. */
export function describeObsidianPlan(plan: ObsidianPlan, c: Palette): string[] {
  const lines: string[] = [];
  for (const f of plan.files) {
    lines.push(c.bold(`${f.file}${f.isNew ? c.dim(' (new)') : ''} (${f.changes.length})`));
    for (const ch of f.changes) {
      const key = ch.path.join('.');
      lines.push(
        ch.from === undefined
          ? `  ${c.green('+')} ${key}: ${show(ch.to)}`
          : `  ${c.yellow('~')} ${key}: ${c.dim(show(ch.from))} ${c.dim('->')} ${show(ch.to)}`,
      );
    }
  }
  if (plan.missingPlugins.length) {
    lines.push(c.bold(`Community plugins not installed in this vault (${plan.missingPlugins.length})`));
    for (const id of plan.missingPlugins) lines.push(`  ${c.yellow('!')} ${id}`);
  }
  if (plan.missingTheme) lines.push(`${c.yellow('!')} theme ${plan.missingTheme} is not installed in this vault`);
  if (plan.ok) lines.push(c.dim(`already in place: ${plan.ok} value${plan.ok === 1 ? '' : 's'}`));
  return lines;
}
