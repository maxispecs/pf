import fs from 'node:fs';
import path from 'node:path';
import { capture } from '@pulpfixer/kit/exec';
import { readJson } from '@pulpfixer/kit/util';
import { EXTENSION_SCOPE, ensurePresetsDir, installArgv, isExtensionPackage, npmError, presetsDir } from './presets.js';

/**
 * An extension package (`@pulpfixer/ext-<name>`) is an npm package that ships one `.vsix` and says which
 * extension it is in its package.json:
 *
 *   "pf": { "extension": { "id": "publisher.name", "vsix": "file.vsix" } }
 *
 * pf installs the latest version into `~/.pf/sys/presets` (next to the presets) and hands the file to the
 * app's launcher (`cursor --install-extension file.vsix --force`). Only the `@pulpfixer` scope is accepted.
 */
export interface ExtensionInfo {
  /** `@pulpfixer/ext-bg-tone`. */
  pkg: string;
  version: string;
  /** Extension id inside the app (`local.bg-tone`). */
  id: string;
  /** Absolute path of the `.vsix`. */
  file: string;
}

const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i;
const VSIX_FILE = /^[\w][\w.-]*\.vsix$/;

/** Check a package.json's `pf.extension`. Returns the id and file name, or why the package is unusable. */
export function validateExtensionManifest(pkg: unknown): { id: string; vsix: string } | string {
  const ext = (pkg as { pf?: { extension?: unknown } } | null)?.pf?.extension;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return 'package.json has no "pf.extension" ({ "id", "vsix" })';
  const { id, vsix } = ext as { id?: unknown; vsix?: unknown };
  if (typeof id !== 'string' || !EXTENSION_ID.test(id)) return '"pf.extension.id" must be an extension id (publisher.name)';
  if (typeof vsix !== 'string' || !VSIX_FILE.test(vsix)) return '"pf.extension.vsix" must be a plain .vsix file name inside the package';
  return { id, vsix };
}

export interface CachedExtension {
  pkg: string;
  version: string;
  info: ExtensionInfo | null;
  /** Why the cached copy is unusable. */
  problem?: string;
}

/** Where a package is installed inside the presets prefix. */
export const extensionDir = (pkg: string): string => path.join(presetsDir(), 'node_modules', ...pkg.split('/'));

/** The copy of an extension package already on this machine, or null when it was never fetched. */
export function cachedExtension(pkg: string): CachedExtension | null {
  const dir = extensionDir(pkg);
  const manifest = readJson<{ version?: string }>(dir, 'package.json');
  if (!manifest) return null;
  const version = manifest.version ?? '';
  const checked = validateExtensionManifest(manifest);
  if (typeof checked === 'string') return { pkg, version, info: null, problem: checked };
  const file = path.join(dir, checked.vsix);
  if (!fs.existsSync(file)) return { pkg, version, info: null, problem: `${checked.vsix} is missing from the package` };
  return { pkg, version, info: { pkg, version, id: checked.id, file } };
}

/** Every extension package already on this machine (`@pulpfixer/ext-<name>` in the presets prefix). */
export function cachedExtensions(): CachedExtension[] {
  const dir = path.join(presetsDir(), 'node_modules', ...EXTENSION_SCOPE.split('/'));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // nothing fetched yet
  }
  return entries
    .map((e) => `${EXTENSION_SCOPE}/${e}`)
    .filter(isExtensionPackage)
    .sort()
    .map((pkg) => cachedExtension(pkg))
    .filter((c): c is CachedExtension => c !== null);
}

export interface FetchedExtension {
  info: ExtensionInfo;
  source: 'registry' | 'cache';
  /** Version cached before this call (registry fetches only), when it differed. */
  previous?: string;
  /** Why the registry could not be used, for a cache fallback. */
  note?: string;
}

/** Get an extension package: install `@latest` from the registry, or with `offline` (or no registry) use the cached copy. */
export function fetchExtension(pkg: string, opts: { offline?: boolean } = {}): FetchedExtension | { error: string } {
  if (!isExtensionPackage(pkg)) return { error: `"${pkg}" is not an extension package (${EXTENSION_SCOPE}/ext-<name>)` };
  const before = cachedExtension(pkg);
  const useCache = (note?: string): FetchedExtension | { error: string } => {
    if (!before) return { error: note ? `${note}, and no copy of ${pkg} is cached yet` : `${pkg} is not cached yet: run without --offline once` };
    if (!before.info) return { error: `the cached ${pkg} v${before.version} is unusable: ${before.problem}` };
    return { info: before.info, source: 'cache', ...(note ? { note } : {}) };
  };
  if (opts.offline) return useCache();

  const dir = ensurePresetsDir();
  const r = capture(installArgv(pkg), { cwd: dir, timeout: 120_000 });
  if (!r.ok) {
    const reason = npmError(r.stderr);
    if (/E404|404/.test(reason)) return { error: `no ${pkg} on the registry` };
    return useCache(`could not reach the registry (${reason})`);
  }
  const now = cachedExtension(pkg);
  if (!now) return { error: `${pkg} installed but holds no package.json` };
  if (!now.info) return { error: `${pkg} v${now.version} is unusable: ${now.problem}` };
  return { info: now.info, source: 'registry', ...(before && before.version !== now.version ? { previous: before.version } : {}) };
}
