import path from 'node:path';
import { capture } from '@pulpfixer/kit/exec';
import { readJson } from '@pulpfixer/kit/util';
import { PRESET_SCOPE, ensurePresetsDir, installArgv, isExtensionPackage, isPresetName, npmError, presetsDir } from './presets.js';

/**
 * The suite is data: the package `@pulpfixer/suite` holds one `suite.json`, a list of features. A feature
 * is a preset (`@pulpfixer/preset-<name>`) and, for an editor, extension packages. A feature is either part
 * of the default set (`pf suite enable` with no name turns those on) or `optional` (only when named).
 * pf installs the latest version into `~/.pf/sys/presets` every time, like a preset.
 */
export interface SuiteFeature {
  /** `cursor`, `obsidian`: what `pf suite enable <id>` takes. */
  id: string;
  summary: string;
  /** The preset that does the work (`cursor` -> `@pulpfixer/preset-cursor`). */
  preset: string;
  /** Extension packages (`@pulpfixer/ext-<name>`) installed with the preset. */
  packages: string[];
  /** Left out of a bare `pf suite enable`: it has to be named (or picked). */
  optional: boolean;
}

export interface Suite {
  summary: string;
  features: SuiteFeature[];
}

export const SUITE_PACKAGE = `${PRESET_SCOPE}/suite`;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Check the content of a `suite.json`. Returns the suite, or why it is unusable. */
export function validateSuite(value: unknown): Suite | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'suite.json is not an object';
  const o = value as Record<string, unknown>;
  if (o.summary !== undefined && typeof o.summary !== 'string') return '"summary" must be a string';
  if (!Array.isArray(o.features)) return 'suite.json needs a "features" array';
  const features: SuiteFeature[] = [];
  for (const f of o.features) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return 'every feature must be an object';
    const x = f as Record<string, unknown>;
    if (typeof x.id !== 'string' || !ID_RE.test(x.id)) return `"${String(x.id)}" is not a feature id (lowercase letters, digits and dashes)`;
    if (features.some((y) => y.id === x.id)) return `feature "${x.id}" is listed twice`;
    if (typeof x.preset !== 'string' || !isPresetName(x.preset)) return `feature "${x.id}" needs a "preset" name`;
    if (x.summary !== undefined && typeof x.summary !== 'string') return `feature "${x.id}": "summary" must be a string`;
    if (x.optional !== undefined && typeof x.optional !== 'boolean') return `feature "${x.id}": "optional" must be true or false`;
    const packages: string[] = [];
    if (x.packages !== undefined) {
      if (!Array.isArray(x.packages)) return `feature "${x.id}": "packages" must be an array`;
      for (const p of x.packages) {
        if (typeof p !== 'string' || !isExtensionPackage(p)) return `feature "${x.id}": "${String(p)}" is not an extension package (@pulpfixer/ext-<name>)`;
        if (!packages.includes(p)) packages.push(p);
      }
    }
    features.push({ id: x.id, summary: typeof x.summary === 'string' ? x.summary : '', preset: x.preset, packages, optional: x.optional === true });
  }
  return { summary: typeof o.summary === 'string' ? o.summary : '', features };
}

export interface CachedSuite {
  version: string;
  suite: Suite | null;
  /** Why the cached copy is unusable. */
  problem?: string;
}

/** Where the suite package is installed inside the presets prefix. */
export const suiteDir = (): string => path.join(presetsDir(), 'node_modules', ...SUITE_PACKAGE.split('/'));

/** The copy of the suite already on this machine, or null when it was never fetched. */
export function cachedSuite(): CachedSuite | null {
  const dir = suiteDir();
  const pkg = readJson<{ version?: string }>(dir, 'package.json');
  if (!pkg) return null;
  const raw = readJson<unknown>(dir, 'suite.json');
  const checked = raw === null ? 'suite.json is missing or not valid JSON' : validateSuite(raw);
  const version = pkg.version ?? '';
  return typeof checked === 'string' ? { version, suite: null, problem: checked } : { version, suite: checked };
}

export interface FetchedSuite {
  suite: Suite;
  version: string;
  /** `registry` when this call installed the latest, `cache` when it fell back to the copy on disk. */
  source: 'registry' | 'cache';
  previous?: string;
  note?: string;
}

/** Get the suite: install `@pulpfixer/suite@latest`, or with `offline` (or no registry) use the copy fetched last time. */
export function fetchSuite(opts: { offline?: boolean } = {}): FetchedSuite | { error: string } {
  const before = cachedSuite();
  const useCache = (note?: string): FetchedSuite | { error: string } => {
    if (!before) return { error: note ? `${note}, and no copy of ${SUITE_PACKAGE} is cached yet` : `${SUITE_PACKAGE} is not cached yet: run without --offline once` };
    if (!before.suite) return { error: `the cached ${SUITE_PACKAGE} v${before.version} is unusable: ${before.problem}` };
    return { suite: before.suite, version: before.version, source: 'cache', ...(note ? { note } : {}) };
  };
  if (opts.offline) return useCache();

  const dir = ensurePresetsDir();
  const r = capture(installArgv(SUITE_PACKAGE), { cwd: dir, timeout: 90_000 });
  if (!r.ok) {
    const reason = npmError(r.stderr);
    if (/E404|404/.test(reason)) return { error: `no ${SUITE_PACKAGE} on the registry` };
    return useCache(`could not reach the registry (${reason})`);
  }
  const now = cachedSuite();
  if (!now) return { error: `${SUITE_PACKAGE} installed but holds no package.json` };
  if (!now.suite) return { error: `${SUITE_PACKAGE} v${now.version} is unusable: ${now.problem}` };
  return { suite: now.suite, version: now.version, source: 'registry', ...(before && before.version !== now.version ? { previous: before.version } : {}) };
}

export const featureOf = (suite: Suite, id: string): SuiteFeature | undefined => suite.features.find((f) => f.id === id);
