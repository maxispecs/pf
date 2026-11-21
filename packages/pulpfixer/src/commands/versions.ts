import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PACKAGE_NAME, pfHome } from '@pulpfixer/kit/constants';
import { out, type Palette } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { compareVersions, readJson, takeFlag } from '@pulpfixer/kit/util';
import { packageRoot, version } from '@pulpfixer/kit/version';
import type { Command } from '@pulpfixer/kit/types';
import { systemVersions, type SystemVersions } from '@pulpfixer/plugin-system';
import { pfOnPath } from '../install/env.js';
import { BUILTIN_PLUGINS } from '../plugins/index.js';
import { loadFailures } from '../plugins/loader.js';
import { bundledVersion, installedPlugins, pluginsDir } from '../plugins/registry.js';
import { BUNDLED_LABEL, PF_SKILLS_LABEL, bundledSkillsDir, pfSkillsDir, shortDescription, skillsIn } from '../skills/discover.js';
import { inspectPath, installedSkills, targetLabel } from '../skills/registry.js';
import { cachedTemplates, templatePackage, type CachedTemplate } from '../templates/templates.js';

export type RowState = 'ok' | 'warn' | 'bad';

export interface VersionRow {
  name: string;
  /** Raw version (`1.4.0`); '' when unknown or not installed. */
  version: string;
  note: string;
  state: RowState;
}

export interface VersionSection {
  id: 'pf' | 'path' | 'bundled' | 'plugins' | 'skills' | 'presets' | 'extensions' | 'templates';
  title: string;
  hint: string;
  /** Shown when there are no rows. */
  empty: string;
  rows: VersionRow[];
}

/** `1.4.0` -> `1.4`, the way pf writes versions. */
const short = (v: string): string => v.replace(/^(\d+\.\d+)\.0$/, '$1');

const row = (name: string, v: string, note = '', state: RowState = 'ok'): VersionRow => ({ name, version: v, note, state });

/** Version of an npm package that ships inside pf, found by resolving `specifier` and walking up to its package.json. */
export function bundledPackageVersion(pkg: string, specifier: string): string {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve(specifier));
    for (let i = 0; i < 5; i++, dir = path.dirname(dir)) {
      const manifest = readJson<{ name?: string; version?: string }>(dir, 'package.json');
      if (manifest?.name === pkg) return manifest.version ?? '';
    }
  } catch {
    // not resolvable from here
  }
  return '';
}

export function pfSection(): VersionSection {
  return {
    id: 'pf',
    title: 'pf',
    hint: 'this installation',
    empty: '',
    rows: [row(PACKAGE_NAME, version(), packageRoot()), row('node', process.versions.node, process.execPath)],
  };
}

/** Every `pf` on PATH. Empty when pf runs from a checkout. A legacy (1.x) one is flagged. */
export function pathSection(installs = pfOnPath()): VersionSection {
  return {
    id: 'path',
    title: 'pf on PATH',
    hint: 'the first one wins',
    empty: 'pf is not on PATH (running from a checkout?)',
    rows: installs.map((p, i) =>
      p.legacy
        ? row('pf', p.version ?? '', `${p.path}: legacy pulpfixer, run pf setup${i === 0 ? ' (wins on PATH)' : ''}`, 'bad')
        : row('pf', p.version ?? '', `${p.path}${i === 0 ? '' : ' (shadowed)'}`, i === 0 && p.version ? 'ok' : 'warn'),
    ),
  };
}

/** The packages that ship inside pf: the kit and the built-in plugins. */
export function bundledSection(): VersionSection {
  return {
    id: 'bundled',
    title: 'Bundled with pf',
    hint: 'pinned by this pf; pf update brings newer ones',
    empty: '',
    rows: [
      row('@pulpfixer/kit', bundledPackageVersion('@pulpfixer/kit', '@pulpfixer/kit/version'), 'shared foundation'),
      ...BUILTIN_PLUGINS.map((p) => {
        const v = bundledVersion(p.name);
        return row(`@pulpfixer/plugin-${p.name}`, v, v ? shortDescription(p.summary, 60) : 'version not found', v ? 'ok' : 'warn');
      }),
    ],
  };
}

/** Plugins installed from the registry (`~/.pf/plugins`), with whether they loaded. */
export function pluginsSection(): VersionSection {
  const failed = new Map(loadFailures().map((f) => [f.package, f]));
  return {
    id: 'plugins',
    title: 'Plugins',
    hint: pluginsDir(),
    empty: 'none installed from the registry (pf plugin available)',
    rows: installedPlugins().map((p) => {
      const f = failed.get(p.package);
      return f ? row(p.name, p.version, `not loaded: ${f.error}`, 'bad') : row(p.name, p.version, p.package, p.version ? 'ok' : 'warn');
    }),
  };
}

/**
 * Skills pf knows: the ones installed from the registry (any agent's folder), what sits in pf's own folder
 * (links to a checkout, hand-made folders) and the ones bundled with pf. Version comes from the package, or
 * from `metadata.version` in SKILL.md.
 */
export function skillsSection(home = os.homedir(), bundled: string | null = bundledSkillsDir(), own: string | null = pfSkillsDir()): VersionSection {
  const rows: VersionRow[] = [];
  const registry = installedSkills(home);
  for (const s of registry) rows.push(row(s.name, s.version, `${targetLabel(s.target)}, registry`));
  const registryHere = new Set(registry.filter((s) => s.target === 'pf').map((s) => s.name));
  if (own) {
    for (const s of skillsIn(own, PF_SKILLS_LABEL)) {
      const dirName = path.basename(s.dir);
      if (registryHere.has(dirName)) continue;
      const kind = inspectPath(s.dir).kind;
      rows.push(row(s.name, s.version ?? '', `${PF_SKILLS_LABEL}, ${kind === 'link' ? 'linked checkout' : 'local folder'}`));
    }
  }
  if (bundled) {
    for (const s of skillsIn(bundled, BUNDLED_LABEL)) {
      const overridden = registryHere.has(path.basename(s.dir)) || rows.some((r) => r.name === s.name && r.note.startsWith(PF_SKILLS_LABEL));
      rows.push(row(s.name, s.version ?? '', overridden ? `bundled with pf (${PF_SKILLS_LABEL} copy is used)` : 'bundled with pf'));
    }
  }
  return {
    id: 'skills',
    title: 'Skills',
    hint: `${PF_SKILLS_LABEL}, agent folders and bundled`,
    empty: 'none (pf skill available)',
    rows: rows.sort((a, b) => a.name.localeCompare(b.name) || a.note.localeCompare(b.note)),
  };
}

/** Presets and suite extensions: what `pf sys apply` fetched, and what Cursor has installed. */
export function systemSections(sys: SystemVersions): VersionSection[] {
  const presets: VersionSection = {
    id: 'presets',
    title: 'Presets',
    hint: '~/.pf/sys/presets, fetched by pf suite enable and pf sys apply',
    empty: 'none fetched yet (pf sys list)',
    rows: [
      ...(sys.suite
        ? [sys.suite.problem ? row('suite', sys.suite.version, `unusable: ${sys.suite.problem}`, 'bad') : row('suite', sys.suite.version, `${sys.suite.package} (${sys.suite.features.join(', ')})`)]
        : []),
      ...sys.presets.map((p) => (p.problem ? row(p.name, p.version, `unusable: ${p.problem}`, 'bad') : row(p.name, p.version, p.package))),
    ],
  };
  const app = sys.app.label;
  const extensions: VersionSection = {
    id: 'extensions',
    title: `${app} extensions`,
    hint: 'the pulpfixer suite',
    empty: 'none (pf suite enable cursor)',
    rows: sys.extensions.map((e) => {
      const name = e.package.replace(/^@pulpfixer\/ext-/, '');
      const id = e.id ?? e.package;
      if (e.problem) return row(name, e.version, `unusable: ${e.problem}`, 'bad');
      if (!sys.app.found) return row(name, e.version, `${id}, fetched; ${app} not found here`);
      if (!sys.app.readable) return row(name, e.version, `${id}, fetched; ${app} extensions could not be read`, 'warn');
      if (e.installed === null) return row(name, '', `${id}, not installed in ${app} (v${short(e.version)} fetched): pf suite enable cursor`, 'warn');
      if (e.installed && e.version && compareVersions(e.version, e.installed) > 0) {
        return row(name, e.installed, `${id}, v${short(e.version)} fetched: pf update`, 'warn');
      }
      return row(name, e.installed, id);
    }),
  };
  return [presets, extensions];
}

/** Templates fetched by `pf template apply` (`~/.pf/templates`). */
export function templatesSection(cached: CachedTemplate[] = cachedTemplates()): VersionSection {
  return {
    id: 'templates',
    title: 'Templates',
    hint: '~/.pf/templates, fetched by pf template apply',
    empty: 'none fetched yet (pf template list)',
    rows: cached.map((t) => (t.problem ? row(t.name, t.version, `unusable: ${t.problem}`, 'bad') : row(t.name, t.version, templatePackage(t.name)))),
  };
}

/** Everything pulpfixer-related on this machine. Reads files and Cursor's extension list; no network. */
export function collectVersions(): VersionSection[] {
  return [pfSection(), pathSection(), bundledSection(), pluginsSection(), skillsSection(), ...systemSections(systemVersions()), templatesSection()];
}

/** The text of the sections, aligned per section. Pure: returns the lines. */
export function versionLines(sections: VersionSection[], c: Palette = out()): string[] {
  const lines: string[] = [];
  for (const s of sections) {
    if (lines.length) lines.push('');
    lines.push(`${c.bold(s.title)}${s.hint ? '  ' + c.dim(s.hint) : ''}`);
    if (!s.rows.length) {
      lines.push(`  ${c.dim(s.empty || 'none')}`);
      continue;
    }
    const nameW = Math.max(...s.rows.map((r) => r.name.length));
    const verOf = (r: VersionRow) => (r.version ? `v${short(r.version)}` : '-');
    const verW = Math.max(...s.rows.map((r) => verOf(r).length));
    for (const r of s.rows) {
      const note = r.state === 'bad' ? c.red(r.note) : r.state === 'warn' ? c.yellow(r.note) : c.dim(r.note);
      lines.push(`  ${c.bold(r.name.padEnd(nameW))}  ${verOf(r).padEnd(verW)}  ${note}`.trimEnd());
    }
  }
  return lines;
}

export const versionsCommand: Command = {
  name: 'versions',
  summary: 'List versions of pf, plugins, skills and extensions installed here',
  group: 'Tools',
  usage: 'pf versions [--json]   (shortcut: pf vs; pf ver is for a repo\'s own versions)',
  async run(_ctx, args) {
    const rest = [...args];
    const asJson = takeFlag(rest, '--json');
    const unknown = rest.find((a) => a.startsWith('-'));
    if (unknown || rest.length) {
      process.stderr.write(`${badgeLabel('error', out())} ${unknown ? `unknown option ${unknown}` : `unexpected argument "${rest[0]}"`}. ${termLine('pf versions [--json]', out())}\n`);
      return 1;
    }
    const sections = collectVersions();
    if (asJson) {
      process.stdout.write(JSON.stringify({ state: pfHome(), sections }, null, 2) + '\n');
      return 0;
    }
    const c = out();
    process.stdout.write(versionLines(sections, c).join('\n') + '\n');
    process.stdout.write(`\n${c.dim('Latest on the registry:')} ${termLine('pf update --check', c)}\n`);
    return 0;
  },
};
