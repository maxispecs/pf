import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_URL, pfHome } from '@pulpfixer/kit/constants';
import { capture } from '@pulpfixer/kit/exec';
import { readJson } from '@pulpfixer/kit/util';

/**
 * Plugins published for pf, from any repo that publishes to cellars:
 *   default      @pf-plugins/<name>
 *   own package  @pf-plugins-<name>/<name>
 * Only these names install, because a plugin runs inside pf with the user's rights.
 *
 * Installed plugins live in an npm prefix at `~/.pf/plugins`. Its package.json `dependencies` are
 * the list pf remembers; `node_modules` holds the code.
 */
export const PLUGIN_SCOPE = '@pf-plugins';

const NAME = '[a-z0-9]+(?:-[a-z0-9]+)*';
const PACKAGE_RE = new RegExp(`^${PLUGIN_SCOPE}(?:-${NAME})?/(${NAME})$`);
const SPEC_RE = /^(.+?)(?:@(latest|\d[\w.+-]*))?$/;

/** Plugins from this monorepo ship inside pf and are published too, as `@pulpfixer/plugin-<name>`. */
export const BUILTIN_SCOPE = '@pulpfixer';
const BUILTIN_RE = new RegExp(`^${BUILTIN_SCOPE}/plugin-(${NAME})$`);

/** `@pulpfixer/plugin-aws` -> `aws`. */
export function builtinOfPackage(name: string): string | null {
  return BUILTIN_RE.exec(name)?.[1] ?? null;
}

export function builtinPackage(plugin: string): string {
  return `${BUILTIN_SCOPE}/plugin-${plugin}`;
}

/** Version of a built-in plugin bundled with this pf, read from its package.json; '' when it cannot be found. */
export function bundledVersion(plugin: string): string {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve(builtinPackage(plugin)));
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      const pkg = readJson<{ name?: string; version?: string }>(dir, 'package.json');
      if (pkg?.name === builtinPackage(plugin)) return pkg.version ?? '';
    }
  } catch {
    // not resolvable from here
  }
  return '';
}

/**
 * Database drivers and query packages live in the company scope next to the built-in plugins:
 * `@pulpfixer/db-<name>` (a driver for `pf db`, open to everyone) and `@pulpfixer/query-<name>` (queries on
 * a database; cellars marks the prefix as clearance, so only cleared users can see or install them).
 * Their plugin name keeps the prefix: `db-mysql`, `query-revrec`.
 */
const SCOPED_RE = new RegExp(`^${BUILTIN_SCOPE}/((?:db|query)-${NAME})$`);
const SCOPED_NAME_RE = new RegExp(`^(?:db|query)-${NAME}$`);

/** `@pulpfixer/query-revrec` -> true. Such packages need clearance on the registry when they are queries. */
export function isQueryPackage(name: string): boolean {
  return new RegExp(`^${BUILTIN_SCOPE}/query-${NAME}$`).test(name);
}

export function isPluginPackage(name: string): boolean {
  return PACKAGE_RE.test(name) || SCOPED_RE.test(name);
}

/** `@pf-plugins-jira/jira` -> `jira`; `@pulpfixer/db-mysql` -> `db-mysql`. */
export function pluginOfPackage(name: string): string | null {
  return PACKAGE_RE.exec(name)?.[1] ?? SCOPED_RE.exec(name)?.[1] ?? null;
}

/** Package names a plugin may be published under, most likely first. */
export function candidatePackages(plugin: string): string[] {
  if (isPluginPackage(plugin)) return [plugin];
  if (SCOPED_NAME_RE.test(plugin)) return [`${BUILTIN_SCOPE}/${plugin}`];
  if (!new RegExp(`^${NAME}$`).test(plugin)) return [];
  return [`${PLUGIN_SCOPE}/${plugin}`, `${PLUGIN_SCOPE}-${plugin}/${plugin}`];
}

/** `jira@1.2` -> `{ name: 'jira', version: '1.2' }`; the version is optional. */
export function parseSpec(spec: string): { name: string; version?: string } {
  const m = SPEC_RE.exec(spec.trim())!;
  return { name: m[1]!, ...(m[2] && m[2] !== 'latest' ? { version: m[2] } : {}) };
}

export function pluginsDir(): string {
  return path.join(pfHome(), 'plugins');
}

/** Create the npm prefix on first use. */
export function ensurePluginsDir(): string {
  const dir = pluginsDir();
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: 'pf-plugins', private: true }, null, 2) + '\n');
  return dir;
}

export interface InstalledPlugin {
  name: string;
  package: string;
  version: string;
  dir: string;
}

/** Plugins pf remembers: the registry packages listed in `~/.pf/plugins/package.json`. */
export function installedPlugins(): InstalledPlugin[] {
  const dir = pluginsDir();
  const deps = readJson<{ dependencies?: Record<string, string> }>(dir, 'package.json')?.dependencies ?? {};
  const found: InstalledPlugin[] = [];
  for (const pkg of Object.keys(deps).sort()) {
    const name = pluginOfPackage(pkg);
    if (!name) continue;
    const pkgDir = path.join(dir, 'node_modules', ...pkg.split('/'));
    const version = readJson<{ version?: string }>(pkgDir, 'package.json')?.version ?? '';
    found.push({ name, package: pkg, version, dir: pkgDir });
  }
  return found;
}

/** The file to import for a plugin package: `exports["."]` (import, then default), `main`, else index.js. */
export function entryOf(pkg: { exports?: unknown; main?: unknown }): string {
  const pick = (x: unknown): string | null => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      for (const k of ['import', 'node', 'default']) {
        const v = pick(o[k]);
        if (v) return v;
      }
    }
    return null;
  };
  const exp = pkg.exports && typeof pkg.exports === 'object' && '.' in (pkg.exports as object) ? (pkg.exports as Record<string, unknown>)['.'] : pkg.exports;
  return pick(exp) ?? (typeof pkg.main === 'string' ? pkg.main : 'index.js');
}

export interface RemotePlugin {
  name: string;
  package: string;
  version: string;
  description: string;
}

export function npmError(stderr: string): string {
  const m = stderr.match(/npm (?:error|ERR!) (?:code )?(E\w+|\d{3}[^\n]*)/)?.[1];
  return (m ?? stderr.trim().split('\n')[0] ?? '').trim() || 'registry unreachable';
}

/** Keep the registry's plugin packages, one per plugin name (the default package wins over an own one). */
export function pickPluginPackages(results: { name?: unknown; version?: unknown; description?: unknown }[]): RemotePlugin[] {
  const byName = new Map<string, RemotePlugin>();
  for (const r of results) {
    if (typeof r.name !== 'string' || typeof r.version !== 'string') continue;
    const name = pluginOfPackage(r.name);
    if (!name) continue;
    const prev = byName.get(name);
    if (prev && prev.package.startsWith(`${PLUGIN_SCOPE}/`)) continue;
    byName.set(name, { name, package: r.name, version: r.version, description: typeof r.description === 'string' ? r.description : '' });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Keep the published built-in plugin packages (`@pulpfixer/plugin-<name>`). */
export function pickBuiltinPackages(results: { name?: unknown; version?: unknown; description?: unknown }[]): RemotePlugin[] {
  const found: RemotePlugin[] = [];
  for (const r of results) {
    if (typeof r.name !== 'string' || typeof r.version !== 'string') continue;
    const name = builtinOfPackage(r.name);
    if (name) found.push({ name, package: r.name, version: r.version, description: typeof r.description === 'string' ? r.description : '' });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse `npm search --json` output, which may carry notices before the array. */
export function parseSearch(stdout: string): { name?: unknown; version?: unknown; description?: unknown }[] {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function search(query: string, timeoutMs: number): { results?: ReturnType<typeof parseSearch>; error?: string } {
  const r = capture(['npm', 'search', query, '--json', '--searchlimit', '250', '--registry', REGISTRY_URL], {
    timeout: timeoutMs,
    cwd: os.tmpdir(),
  });
  return r.ok ? { results: parseSearch(r.stdout) } : { error: npmError(r.stderr) };
}

/**
 * Every installable plugin on the registry, from `npm search`: the `@pf-plugins` scope, plus the drivers and
 * query packages in `@pulpfixer` (a query package only shows for an account with clearance).
 */
export function searchRemote(timeoutMs = 30_000): { plugins?: RemotePlugin[]; error?: string } {
  const mine = search(PLUGIN_SCOPE.slice(1), timeoutMs);
  const scoped = search(BUILTIN_SCOPE, timeoutMs);
  if (!mine.results && !scoped.results) return { error: mine.error };
  return { plugins: pickPluginPackages([...(mine.results ?? []), ...(scoped.results ?? [])]) };
}

/** Built-in plugins as published on the registry. */
export function searchBuiltins(timeoutMs = 30_000): { plugins?: RemotePlugin[]; error?: string } {
  const r = search(BUILTIN_SCOPE, timeoutMs);
  return r.results ? { plugins: pickBuiltinPackages(r.results) } : { error: r.error };
}

/** Latest version of one plugin (or of the exact `version`). Tries the default package, then the plugin's own. */
export function viewRemote(pluginOrPackage: string, version?: string, timeoutMs = 20_000): { plugin?: RemotePlugin; error?: string } {
  const candidates = candidatePackages(pluginOrPackage);
  if (!candidates.length) return { error: `"${pluginOrPackage}" is not a plugin name (use ${PLUGIN_SCOPE}/<name> or just <name>)` };
  let error = '';
  for (const pkg of candidates) {
    const r = capture(['npm', 'view', version ? `${pkg}@${version}` : pkg, 'name', 'version', 'description', '--json', '--registry', REGISTRY_URL], {
      timeout: timeoutMs,
      cwd: os.tmpdir(),
    });
    if (r.ok) {
      try {
        const v = JSON.parse(r.stdout) as { version?: string; description?: string };
        if (v.version) return { plugin: { name: pluginOfPackage(pkg)!, package: pkg, version: v.version, description: v.description ?? '' } };
      } catch {
        // fall through to the next candidate
      }
    }
    error = npmError(r.stderr);
    if (!/E404|404/.test(error)) break;
  }
  if (/E404|404/.test(error)) {
    // The registry answers 404 for a package the account may not read, so a query package may only be out of reach.
    if (candidates.length === 1 && isQueryPackage(candidates[0]!)) return { error: `no ${candidates[0]} on the registry, or your account lacks the clearance to see it` };
    return { error: `no ${candidates.join(' or ')} on the registry` };
  }
  return { error };
}

/** npm arguments that install `<package>@<version>` into the plugins prefix. */
export function installArgv(pkg: string, version = 'latest'): string[] {
  return ['npm', 'install', `${pkg}@${version}`, '--prefix', pluginsDir(), '--registry', REGISTRY_URL, '--no-audit', '--no-fund', '--loglevel', 'error'];
}

/** npm arguments that remove a package from the plugins prefix. */
export function uninstallArgv(pkg: string): string[] {
  return ['npm', 'uninstall', pkg, '--prefix', pluginsDir(), '--no-audit', '--no-fund', '--loglevel', 'error'];
}
