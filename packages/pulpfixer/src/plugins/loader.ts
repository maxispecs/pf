import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerDbDrivers, validateDbDriver } from '@pulpfixer/kit/db';
import { registerIoAdapters, validateIoAdapter } from '@pulpfixer/kit/io';
import { PLUGIN_API, type Plugin } from '@pulpfixer/kit/plugin';
import { readJson } from '@pulpfixer/kit/util';
import { entryOf, installedPlugins, type InstalledPlugin } from './registry.js';

export interface LoadedPlugin {
  plugin: Plugin;
  package: string;
  version: string;
}

export interface LoadFailure {
  package: string;
  version: string;
  error: string;
}

let loaded: LoadedPlugin[] = [];
let failures: LoadFailure[] = [];

/** Plugins imported from `~/.pf/plugins` by the last `loadInstalledPlugins`. */
export const loadedPlugins = (): LoadedPlugin[] => loaded;
export const loadFailures = (): LoadFailure[] => failures;

/** Check what a plugin package exported. Returns the plugin, or why it is unusable. */
export function validatePlugin(value: unknown): Plugin | string {
  const mod = value as { default?: unknown; plugin?: unknown } | null;
  const p = (mod && typeof mod === 'object' ? (mod.default ?? mod.plugin) : null) as Partial<Plugin> | null;
  if (!p || typeof p !== 'object') return 'it does not export a plugin (default export or `plugin`)';
  if (typeof p.name !== 'string' || !p.name) return 'the plugin has no name';
  if (!Array.isArray(p.commands)) return 'the plugin has no commands array';
  for (const c of p.commands) {
    if (!c || typeof c.name !== 'string' || typeof c.run !== 'function') return 'a command is missing its name or run()';
  }
  if (p.tools !== undefined && typeof p.tools !== 'function') return 'tools must be a function returning the tool list';
  if (p.api !== undefined && (typeof p.api !== 'number' || p.api > PLUGIN_API)) return `it needs plugin API ${String(p.api)}, this pf has ${PLUGIN_API}: run pf update`;
  if (p.dbDrivers !== undefined) {
    if (!Array.isArray(p.dbDrivers)) return 'dbDrivers must be an array of database drivers';
    if ((p.api ?? 1) < 2) return 'dbDrivers needs "api": 2';
    for (const d of p.dbDrivers) {
      const problem = validateDbDriver(d);
      if (problem) return problem;
    }
  }
  if (p.ioAdapters !== undefined) {
    if (!Array.isArray(p.ioAdapters)) return 'ioAdapters must be an array of IO adapters';
    if ((p.api ?? 1) < 3) return 'ioAdapters needs "api": 3';
    for (const a of p.ioAdapters) {
      const problem = validateIoAdapter(a);
      if (problem) return problem;
    }
  }
  return p as Plugin;
}

/**
 * Make what these plugins contribute known: their database drivers (for `pf db` and query packages) and
 * their IO adapters (for pipes). `builtin` says they ship inside pf, which `pf io adapters` shows.
 */
export function registerPluginContributions(plugins: readonly Plugin[], builtin = false): void {
  for (const p of plugins) {
    if (p.dbDrivers?.length) registerDbDrivers(p.dbDrivers);
    if (p.ioAdapters?.length) registerIoAdapters(p.ioAdapters, builtin ? 'built in' : `plugin ${p.name}`);
  }
}

async function loadOne(info: InstalledPlugin): Promise<LoadedPlugin | string> {
  if (!info.version) return 'listed in ~/.pf/plugins/package.json but not installed: pf plugin install ' + info.name;
  const manifest = readJson<{ exports?: unknown; main?: unknown }>(info.dir, 'package.json') ?? {};
  try {
    const mod = (await import(pathToFileURL(path.join(info.dir, entryOf(manifest))).href)) as unknown;
    const checked = validatePlugin(mod);
    return typeof checked === 'string' ? checked : { plugin: checked, package: info.package, version: info.version };
  } catch (e) {
    return e instanceof Error ? e.message.split('\n')[0]! : String(e);
  }
}

/** Import one plugin installed after startup and register its database drivers and IO adapters. Returns why it failed, or null. */
export async function loadInstalledPlugin(name: string): Promise<string | null> {
  const info = installedPlugins().find((p) => p.name === name);
  if (!info) return `${name} is not installed`;
  const r = await loadOne(info);
  failures = failures.filter((f) => f.package !== info.package);
  if (typeof r === 'string') {
    failures.push({ package: info.package, version: info.version, error: r });
    return r;
  }
  loaded = [...loaded.filter((l) => l.package !== info.package), r];
  registerPluginContributions([r.plugin]);
  return null;
}

/**
 * Import every installed plugin, once, before commands are looked up. A plugin that fails to load
 * (or reuses a built-in plugin's name) is skipped and reported by `pf plugin list`; it never stops pf.
 * Skipped entirely with PF_NO_PLUGINS=1.
 */
export async function loadInstalledPlugins(reservedNames: string[] = []): Promise<void> {
  loaded = [];
  failures = [];
  if (process.env.PF_NO_PLUGINS) return;
  const taken = new Set(reservedNames);
  for (const info of installedPlugins()) {
    const r = await loadOne(info);
    if (typeof r === 'string') {
      failures.push({ package: info.package, version: info.version, error: r });
    } else if (taken.has(r.plugin.name)) {
      failures.push({ package: info.package, version: info.version, error: `a plugin named "${r.plugin.name}" is already loaded` });
    } else {
      taken.add(r.plugin.name);
      loaded.push(r);
      registerPluginContributions([r.plugin]);
    }
  }
}
