import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_URL, pfHome } from '@pulpfixer/kit/constants';
import { capture } from '@pulpfixer/kit/exec';
import { readJson } from '@pulpfixer/kit/util';

/**
 * A preset is data, never code: the package `@pulpfixer/preset-<name>` holds one `preset.json`. pf
 * installs the latest version of it into `~/.pf/sys/presets` every time it applies a preset, so
 * changing a team standard is a version bump on the registry and needs no new pf.
 */
export interface Preset {
  /** Which app adapter applies it (`cursor`). */
  app: string;
  summary: string;
  /** Extension ids (`publisher.name`). */
  extensions: string[];
  /** Settings keys to set, with the values they must have. */
  settings: Record<string, unknown>;
  /**
   * Extension packages (`@pulpfixer/ext-<name>`): each ships a `.vsix` that pf installs (or updates)
   * from the registry. Only this scope is accepted, so a preset still names nothing outside pf's own suite.
   */
  packages: string[];
}

export const PRESET_SCOPE = '@pulpfixer';
const NAME = '[a-z0-9]+(?:-[a-z0-9]+)*';
const NAME_RE = new RegExp(`^${NAME}$`);
const PACKAGE_RE = new RegExp(`^${PRESET_SCOPE}/preset-(${NAME})$`);
export const EXTENSION_SCOPE = '@pulpfixer';
const EXT_PACKAGE_RE = new RegExp(`^${EXTENSION_SCOPE}/ext-${NAME}$`);
const EXTENSION_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i;

export const isPresetName = (name: string): boolean => NAME_RE.test(name);
export const isExtensionPackage = (pkg: string): boolean => EXT_PACKAGE_RE.test(pkg);
export const presetPackage = (name: string): string => `${PRESET_SCOPE}/preset-${name}`;

/** `@pulpfixer/preset-cursor` -> `cursor`. */
export function presetOfPackage(pkg: string): string | null {
  return PACKAGE_RE.exec(pkg)?.[1] ?? null;
}

/** Check the content of a `preset.json`. Returns the preset, or why it is unusable. */
export function validatePreset(value: unknown): Preset | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'preset.json is not an object';
  const o = value as Record<string, unknown>;
  if (typeof o.app !== 'string' || !NAME_RE.test(o.app)) return 'preset.json needs an "app" (for example "cursor")';
  if (o.summary !== undefined && typeof o.summary !== 'string') return '"summary" must be a string';
  const extensions: string[] = [];
  if (o.extensions !== undefined) {
    if (!Array.isArray(o.extensions)) return '"extensions" must be an array of publisher.name ids';
    for (const e of o.extensions) {
      if (typeof e !== 'string' || !EXTENSION_RE.test(e)) return `"${String(e)}" is not an extension id (publisher.name)`;
      if (!extensions.some((x) => x.toLowerCase() === e.toLowerCase())) extensions.push(e);
    }
  }
  const packages: string[] = [];
  if (o.packages !== undefined) {
    if (!Array.isArray(o.packages)) return '"packages" must be an array of @pulpfixer/ext-<name> package names';
    for (const p of o.packages) {
      if (typeof p !== 'string' || !EXT_PACKAGE_RE.test(p)) return `"${String(p)}" is not an extension package (@pulpfixer/ext-<name>)`;
      if (!packages.includes(p)) packages.push(p);
    }
  }
  const settings: Record<string, unknown> = {};
  if (o.settings !== undefined) {
    if (!o.settings || typeof o.settings !== 'object' || Array.isArray(o.settings)) return '"settings" must be an object';
    for (const [k, v] of Object.entries(o.settings)) {
      if (!k || k === '__proto__') return `"${k}" is not a settings key`;
      settings[k] = v;
    }
  }
  return { app: o.app, summary: typeof o.summary === 'string' ? o.summary : '', extensions, settings, packages };
}

/** The npm prefix presets are installed into. */
export const presetsDir = (): string => path.join(pfHome(), 'sys', 'presets');

export function ensurePresetsDir(): string {
  const dir = presetsDir();
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: 'pf-presets', private: true }, null, 2) + '\n');
  return dir;
}

/** npm arguments that install the latest `<package>` into the presets prefix. */
export function installArgv(pkg: string, version = 'latest'): string[] {
  return ['npm', 'install', `${pkg}@${version}`, '--prefix', presetsDir(), '--registry', REGISTRY_URL, '--no-audit', '--no-fund', '--loglevel', 'error'];
}

export function npmError(stderr: string): string {
  const m = stderr.match(/npm (?:error|ERR!) (?:code )?(E\w+|\d{3}[^\n]*)/)?.[1];
  return (m ?? stderr.trim().split('\n')[0] ?? '').trim() || 'registry unreachable';
}

export interface CachedPreset {
  name: string;
  version: string;
  preset: Preset | null;
  /** Why the cached copy is unusable. */
  problem?: string;
}

/** The copy of a preset already on this machine, or null when it was never fetched. */
export function cachedPreset(name: string): CachedPreset | null {
  const dir = path.join(presetsDir(), 'node_modules', ...presetPackage(name).split('/'));
  const pkg = readJson<{ version?: string }>(dir, 'package.json');
  if (!pkg) return null;
  const raw = readJson<unknown>(dir, 'preset.json');
  const checked = raw === null ? 'preset.json is missing or not valid JSON' : validatePreset(raw);
  const version = pkg.version ?? '';
  return typeof checked === 'string' ? { name, version, preset: null, problem: checked } : { name, version, preset: checked };
}

/** Every preset on this machine. */
export function cachedPresets(): CachedPreset[] {
  const dir = path.join(presetsDir(), 'node_modules', ...PRESET_SCOPE.split('/'));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // nothing fetched yet
  }
  return entries
    .map((e) => (e.startsWith('preset-') ? e.slice('preset-'.length) : null))
    .filter((n): n is string => n !== null && isPresetName(n))
    .sort()
    .map((n) => cachedPreset(n))
    .filter((c): c is CachedPreset => c !== null);
}

export interface FetchedPreset {
  name: string;
  preset: Preset;
  version: string;
  /** `registry` when this call installed the latest, `cache` when it fell back to the copy on disk. */
  source: 'registry' | 'cache';
  /** Version that was cached before this call (registry fetches only), when it differed. */
  previous?: string;
  /** Why the registry could not be used, for a cache fallback. */
  note?: string;
}

/**
 * Get a preset: install `@pulpfixer/preset-<name>@latest` from the registry, or with `offline` (or
 * when the registry cannot be reached) use the copy fetched last time.
 */
export function fetchPreset(name: string, opts: { offline?: boolean } = {}): FetchedPreset | { error: string } {
  if (!isPresetName(name)) return { error: `"${name}" is not a preset name (lowercase letters, digits and dashes)` };
  const before = cachedPreset(name);
  const useCache = (note?: string): FetchedPreset | { error: string } => {
    if (!before) return { error: note ? `${note}, and no copy of ${name} is cached yet` : `${name} is not cached yet: run without --offline once` };
    if (!before.preset) return { error: `the cached ${name} v${before.version} is unusable: ${before.problem}` };
    return { name, preset: before.preset, version: before.version, source: 'cache', ...(note ? { note } : {}) };
  };
  if (opts.offline) return useCache();

  const dir = ensurePresetsDir();
  const r = capture(installArgv(presetPackage(name)), { cwd: dir, timeout: 90_000 });
  if (!r.ok) {
    const reason = npmError(r.stderr);
    if (/E404|404/.test(reason)) return { error: `no ${presetPackage(name)} on the registry (pf sys list shows what exists)` };
    return useCache(`could not reach the registry (${reason})`);
  }
  const now = cachedPreset(name);
  if (!now) return { error: `${presetPackage(name)} installed but holds no package.json` };
  if (!now.preset) return { error: `${presetPackage(name)} v${now.version} is unusable: ${now.problem}` };
  return {
    name,
    preset: now.preset,
    version: now.version,
    source: 'registry',
    ...(before && before.version !== now.version ? { previous: before.version } : {}),
  };
}

export interface RemotePreset {
  name: string;
  package: string;
  version: string;
  description: string;
}

/** Keep the registry's preset packages out of `npm search` results. */
export function pickPresetPackages(results: { name?: unknown; version?: unknown; description?: unknown }[]): RemotePreset[] {
  const found: RemotePreset[] = [];
  for (const r of results) {
    if (typeof r.name !== 'string' || typeof r.version !== 'string') continue;
    const name = presetOfPackage(r.name);
    if (name) found.push({ name, package: r.name, version: r.version, description: typeof r.description === 'string' ? r.description : '' });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse `npm search --json` output, which may carry notices before the array. */
export function parseSearch(stdout: string): { name?: unknown; version?: unknown; description?: unknown }[] {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Presets published to the registry. */
export function searchPresets(timeoutMs = 30_000): { presets?: RemotePreset[]; error?: string } {
  const r = capture(['npm', 'search', `${PRESET_SCOPE}/preset-`, '--json', '--searchlimit', '250', '--registry', REGISTRY_URL], {
    timeout: timeoutMs,
    cwd: os.tmpdir(),
  });
  return r.ok ? { presets: pickPresetPackages(parseSearch(r.stdout)) } : { error: npmError(r.stderr) };
}
