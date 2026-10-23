import fs from 'node:fs';
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

export function isPluginPackage(name: string): boolean {
  return PACKAGE_RE.test(name);
}

/** `@pf-plugins-jira/jira` -> `jira`. */
export function pluginOfPackage(name: string): string | null {
  return PACKAGE_RE.exec(name)?.[1] ?? null;
}

/** Package names a plugin may be published under, most likely first. */
export function candidatePackages(plugin: string): string[] {
  if (isPluginPackage(plugin)) return [plugin];
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

function npmError(stderr: string): string {
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

/** Every plugin on the registry, from `npm search`. */
export function searchRemote(timeoutMs = 30_000): { plugins?: RemotePlugin[]; error?: string } {
  const r = capture(['npm', 'search', PLUGIN_SCOPE.slice(1), '--json', '--searchlimit', '250', '--registry', REGISTRY_URL], {
    timeout: timeoutMs,
    cwd: os.tmpdir(),
  });
  if (!r.ok) return { error: npmError(r.stderr) };
  return { plugins: pickPluginPackages(parseSearch(r.stdout)) };
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
  return { error: /E404|404/.test(error) ? `no ${candidates.join(' or ')} on the registry` : error };
}

/** npm arguments that install `<package>@<version>` into the plugins prefix. */
export function installArgv(pkg: string, version = 'latest'): string[] {
  return ['npm', 'install', `${pkg}@${version}`, '--prefix', pluginsDir(), '--registry', REGISTRY_URL, '--no-audit', '--no-fund', '--loglevel', 'error'];
}

/** npm arguments that remove a package from the plugins prefix. */
export function uninstallArgv(pkg: string): string[] {
  return ['npm', 'uninstall', pkg, '--prefix', pluginsDir(), '--no-audit', '--no-fund', '--loglevel', 'error'];
}
