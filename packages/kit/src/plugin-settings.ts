import { userConfigPath, writeHomeFile } from './config.js';
import { readJson } from './util.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A plugin's saved settings: `plugins.<name>` in `~/.pf/config.json`. */
export function pluginSettings(name: string): Obj {
  const plugins = readJson<{ plugins?: unknown }>(userConfigPath())?.plugins;
  const mine = isObj(plugins) ? plugins[name] : undefined;
  return isObj(mine) ? mine : {};
}

/** Merge `patch` into a plugin's settings (a key set to undefined is removed). False when the pf home is read-only. */
export function savePluginSettings(name: string, patch: Obj): boolean {
  const config = readJson<Obj>(userConfigPath()) ?? {};
  const merged: Obj = { ...pluginSettings(name), ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const plugins = isObj(config.plugins) ? config.plugins : {};
  return writeHomeFile('config.json', JSON.stringify({ ...config, plugins: { ...plugins, [name]: merged } }, null, 2) + '\n');
}
