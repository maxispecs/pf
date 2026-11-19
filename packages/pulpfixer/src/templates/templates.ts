import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_URL, pfHome } from '@pulpfixer/kit/constants';
import { capture } from '@pulpfixer/kit/exec';
import { readJson } from '@pulpfixer/kit/util';
import { npmError, parseSearch } from '../plugins/registry.js';
import { validateTemplate, type Template } from './render.js';

/**
 * A template is the data package `@pulpfixer/template-<name>`: `template.json` and a `files/` tree.
 * pf installs its latest version into `~/.pf/templates` every time it applies one, so a template
 * changes with a version bump on the registry and needs no new pf.
 */
export const TEMPLATE_SCOPE = '@pulpfixer';
const NAME = '[a-z0-9]+(?:-[a-z0-9]+)*';
const NAME_RE = new RegExp(`^${NAME}$`);
const PACKAGE_RE = new RegExp(`^${TEMPLATE_SCOPE}/template-(${NAME})$`);

export const isTemplateName = (name: string): boolean => NAME_RE.test(name);
export const templatePackage = (name: string): string => `${TEMPLATE_SCOPE}/template-${name}`;

/** `@pulpfixer/template-query-package` -> `query-package`. */
export function templateOfPackage(pkg: string): string | null {
  return PACKAGE_RE.exec(pkg)?.[1] ?? null;
}

/** The npm prefix templates are installed into. */
export const templatesDir = (): string => path.join(pfHome(), 'templates');

export function ensureTemplatesDir(): string {
  const dir = templatesDir();
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: 'pf-templates', private: true }, null, 2) + '\n');
  return dir;
}

/** npm arguments that install `<package>@<version>` into the templates prefix. */
export function installArgv(pkg: string, version = 'latest'): string[] {
  return ['npm', 'install', `${pkg}@${version}`, '--prefix', templatesDir(), '--registry', REGISTRY_URL, '--no-audit', '--no-fund', '--loglevel', 'error'];
}

export interface CachedTemplate {
  name: string;
  version: string;
  /** The installed package directory (holds `template.json` and `files/`). */
  dir: string;
  template: Template | null;
  /** Why the cached copy is unusable. */
  problem?: string;
}

/** Read a template package directory. */
export function readTemplateDir(name: string, dir: string): CachedTemplate | null {
  const pkg = readJson<{ version?: string }>(dir, 'package.json');
  if (!pkg) return null;
  const version = pkg.version ?? '';
  const raw = readJson<unknown>(dir, 'template.json');
  const checked = raw === null ? 'template.json is missing or not valid JSON' : validateTemplate(raw);
  if (typeof checked === 'string') return { name, version, dir, template: null, problem: checked };
  if (!fs.existsSync(path.join(dir, 'files'))) return { name, version, dir, template: null, problem: 'the package has no files/ folder' };
  return { name, version, dir, template: checked };
}

/** The copy of a template already on this machine, or null when it was never fetched. */
export function cachedTemplate(name: string): CachedTemplate | null {
  return readTemplateDir(name, path.join(templatesDir(), 'node_modules', ...templatePackage(name).split('/')));
}

/** Every template on this machine. */
export function cachedTemplates(): CachedTemplate[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(templatesDir(), 'node_modules', ...TEMPLATE_SCOPE.split('/')));
  } catch {
    // nothing fetched yet
  }
  return entries
    .map((e) => (e.startsWith('template-') ? e.slice('template-'.length) : null))
    .filter((n): n is string => n !== null && isTemplateName(n))
    .sort()
    .map((n) => cachedTemplate(n))
    .filter((c): c is CachedTemplate => c !== null);
}

export interface FetchedTemplate {
  name: string;
  version: string;
  dir: string;
  template: Template;
  /** `registry` when this call installed the latest, `cache` when it fell back to the copy on disk. */
  source: 'registry' | 'cache';
  /** Version that was cached before this call (registry fetches only), when it differed. */
  previous?: string;
  /** Why the registry could not be used, for a cache fallback. */
  note?: string;
}

/**
 * Get a template: install `@pulpfixer/template-<name>@latest` from the registry, or with `offline` (or
 * when the registry cannot be reached) use the copy fetched last time.
 */
export function fetchTemplate(name: string, opts: { offline?: boolean } = {}): FetchedTemplate | { error: string } {
  if (!isTemplateName(name)) return { error: `"${name}" is not a template name (lowercase letters, digits and dashes)` };
  const before = cachedTemplate(name);
  const useCache = (note?: string): FetchedTemplate | { error: string } => {
    if (!before) return { error: note ? `${note}, and no copy of ${name} is cached yet` : `${name} is not cached yet: run without --offline once` };
    if (!before.template) return { error: `the cached ${name} v${before.version} is unusable: ${before.problem}` };
    return { name, version: before.version, dir: before.dir, template: before.template, source: 'cache', ...(note ? { note } : {}) };
  };
  if (opts.offline) return useCache();

  const dir = ensureTemplatesDir();
  const r = capture(installArgv(templatePackage(name)), { cwd: dir, timeout: 90_000 });
  if (!r.ok) {
    const reason = npmError(r.stderr);
    if (/E404|404/.test(reason)) return { error: `no ${templatePackage(name)} on the registry (pf template list shows what exists)` };
    return useCache(`could not reach the registry (${reason})`);
  }
  const now = cachedTemplate(name);
  if (!now) return { error: `${templatePackage(name)} installed but holds no package.json` };
  if (!now.template) return { error: `${templatePackage(name)} v${now.version} is unusable: ${now.problem}` };
  return {
    name,
    version: now.version,
    dir: now.dir,
    template: now.template,
    source: 'registry',
    ...(before && before.version !== now.version ? { previous: before.version } : {}),
  };
}

export interface RemoteTemplate {
  name: string;
  package: string;
  version: string;
  description: string;
}

/** Keep the registry's template packages out of `npm search` results. */
export function pickTemplatePackages(results: { name?: unknown; version?: unknown; description?: unknown }[]): RemoteTemplate[] {
  const found: RemoteTemplate[] = [];
  for (const r of results) {
    if (typeof r.name !== 'string' || typeof r.version !== 'string') continue;
    const name = templateOfPackage(r.name);
    if (name) found.push({ name, package: r.name, version: r.version, description: typeof r.description === 'string' ? r.description : '' });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Templates published to the registry. */
export function searchTemplates(timeoutMs = 30_000): { templates?: RemoteTemplate[]; error?: string } {
  const r = capture(['npm', 'search', `${TEMPLATE_SCOPE}/template-`, '--json', '--searchlimit', '250', '--registry', REGISTRY_URL], {
    timeout: timeoutMs,
    cwd: os.tmpdir(),
  });
  return r.ok ? { templates: pickTemplatePackages(parseSearch(r.stdout)) } : { error: npmError(r.stderr) };
}
