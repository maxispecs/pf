import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY_URL } from '@pulpfixer/kit/constants';
import { runCmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { reporter } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { compareVersions } from '@pulpfixer/kit/util';
import { shortDescription } from '../skills/discover.js';
import { loadFailures, loadInstalledPlugin } from './loader.js';
import { BUILTIN_PLUGINS } from './index.js';
import {
  bundledVersion,
  ensurePluginsDir,
  installArgv,
  installedPlugins,
  parseSpec,
  pluginOfPackage,
  pluginsDir,
  searchBuiltins,
  searchRemote,
  uninstallArgv,
  viewRemote,
  type RemotePlugin,
} from './registry.js';

const AUTH_HINT = 'Check NPM_TOKEN and the auth line in ~/.npmrc (pf setup fixes the latter)';

/** `1.4.0` -> `1.4`, the way pf writes versions. */
const short = (v: string): string => v.replace(/^(\d+\.\d+)\.0$/, '$1');

/** `pf plugin` / `pf plugin list`: built-in plugins, installed ones and any that failed to load. */
export function listPlugins(): number {
  const c = out();
  const w = (s: string) => process.stdout.write(s + '\n');
  const installed = installedPlugins();
  const failed = new Map(loadFailures().map((f) => [f.package, f]));
  const width = Math.max(8, ...BUILTIN_PLUGINS.map((p) => p.name.length), ...installed.map((p) => p.name.length));
  w(c.bold('Built in'));
  for (const p of BUILTIN_PLUGINS) w(`  ${c.bold(p.name.padEnd(width))}  ${c.dim('built in'.padEnd(10))}  ${p.summary}`);
  w('');
  w(c.bold('Installed'));
  if (!installed.length) w(`  ${c.dim('none yet:')} ${termLine('pf plugin available', c)}`);
  for (const p of installed) {
    const f = failed.get(p.package);
    const state = f ? c.red(`not loaded: ${f.error}`) : c.green('loaded');
    w(`  ${c.bold(p.name.padEnd(width))}  ${c.dim(('v' + (p.version ? short(p.version) : '?')).padEnd(10))}  ${state}`);
  }
  w(`\n${c.dim('kept in')} ${pluginsDir()}`);
  return failed.size ? 1 : 0;
}

export interface BuiltinRow {
  name: string;
  summary: string;
  /** Version bundled with this pf; '' when pf does not ship it. */
  bundled: string;
  /** Latest version on the registry; '' when unpublished or not searched. */
  published: string;
}

/** Built-in plugins next to their published packages, plus published ones this pf does not ship yet. */
export function builtinRows(builtins: { name: string; summary: string; bundled: string }[], published: RemotePlugin[]): BuiltinRow[] {
  const rows: BuiltinRow[] = builtins.map((b) => ({ ...b, published: published.find((p) => p.name === b.name)?.version ?? '' }));
  for (const p of published) {
    if (!rows.some((r) => r.name === p.name)) rows.push({ name: p.name, summary: p.description, bundled: '', published: p.version });
  }
  return rows;
}

/** `pf plugin available`: built-in plugins and what the registry has, with what is installed here. */
export function listAvailable(): number {
  const c = out();
  const w = (s: string) => process.stdout.write(s + '\n');
  const builtins = searchBuiltins();
  const found = searchRemote();
  const rows = builtinRows(
    BUILTIN_PLUGINS.map((p) => ({ name: p.name, summary: p.summary, bundled: bundledVersion(p.name) })),
    builtins.plugins ?? [],
  );
  const remote = found.plugins ?? [];
  const width = Math.max(8, ...rows.map((r) => r.name.length), ...remote.map((p) => p.name.length));
  const ver = (v: string) => (v ? `v${short(v)}` : '').padEnd(6);

  w(c.bold('Built in') + c.dim('  ship with pf, published as @pulpfixer/plugin-<name>'));
  for (const r of rows) {
    const state = !r.bundled
      ? c.yellow('newer pf ships it: pf update')
      : r.published && compareVersions(r.published, r.bundled) > 0
        ? c.yellow(`v${short(r.published)} on the registry: pf update`)
        : c.green('built in');
    w(`  ${c.bold(r.name.padEnd(width))}  ${ver(r.bundled || r.published)}  ${c.dim(shortDescription(r.summary, 60))}  ${state}`);
  }
  w('');
  w(c.bold('Registry') + c.dim('  @pf-plugins/<name>, install with pf plugin install'));
  if (found.plugins && !remote.length) w(`  ${c.dim(`none on ${REGISTRY_URL}`)}`);
  const installed = installedPlugins();
  for (const p of remote) {
    const mine = installed.find((i) => i.name === p.name);
    const state = BUILTIN_PLUGINS.some((b) => b.name === p.name)
      ? c.dim('built into pf: not installable')
      : !mine
        ? c.dim('not installed')
        : compareVersions(p.version, mine.version) > 0
          ? c.yellow(`update: v${short(mine.version)}`)
          : c.green('installed');
    w(`  ${c.bold(p.name.padEnd(width))}  ${ver(p.version)}  ${c.dim(shortDescription(p.description, 60))}  ${state}`);
  }
  const error = found.error ?? builtins.error;
  if (error) {
    process.stderr.write(`${badgeLabel('error', err())} could not search ${REGISTRY_URL}: ${error}\n${AUTH_HINT}\n`);
    return 1;
  }
  w(`\n${c.dim('install:')} ${termLine('pf plugin install <name>', c)}`);
  return 0;
}

/** `pf plugin install <name[@version]...>`. */
export async function installPlugins(specs: string[], opts: { dryRun?: boolean } = {}): Promise<number> {
  const r = reporter(out());
  let fails = 0;
  for (const spec of specs) {
    const { name, version } = parseSpec(spec);
    r.step(name);
    const found = viewRemote(name, version);
    if (!found.plugin) {
      r.fail(found.error!);
      if (!/^no |is not a plugin name/.test(found.error!)) r.info(AUTH_HINT);
      fails++;
      continue;
    }
    const p = found.plugin;
    if (BUILTIN_PLUGINS.some((b) => b.name === p.name)) {
      r.warn(`${p.name} is built into pf: not installed`);
      fails++;
      continue;
    }
    const mine = installedPlugins().find((i) => i.package === p.package);
    if (mine && mine.version && compareVersions(p.version, mine.version) === 0) {
      r.ok(`v${short(p.version)} is installed`);
      continue;
    }
    if (!opts.dryRun) ensurePluginsDir();
    const code = await runCmd({ argv: installArgv(p.package, p.version) }, { dryRun: opts.dryRun, quiet: true });
    if (code !== 0) {
      r.fail(`npm install failed for ${p.package}@${p.version}`);
      r.info(AUTH_HINT);
      fails++;
    } else if (!opts.dryRun) r.ok(`installed ${p.package}@${short(p.version)}${mine?.version ? ` (was v${short(mine.version)})` : ''}`);
  }
  return fails ? 1 : 0;
}

/** The `pf db` driver installer: install `@pulpfixer/db-<id>` and load it into this run. Returns why it failed, or null. */
export async function installDbDriver(id: string): Promise<string | null> {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return `"${id}" is not a driver name`;
  const name = `db-${id}`;
  if ((await installPlugins([name])) !== 0) return `pf plugin install ${name} failed`;
  return loadInstalledPlugin(name);
}

/** `pf plugin remove <name...>`: registry installs only; built-in plugins stay. */
export async function removePlugins(names: string[], opts: { dryRun?: boolean } = {}): Promise<number> {
  const r = reporter(out());
  let fails = 0;
  const all = installedPlugins();
  for (const n of names) {
    const given = parseSpec(n).name;
    const name = pluginOfPackage(given) ?? given.replace(/^@pf-plugins(?:-[^/]+)?\//, '');
    const hit = all.find((p) => p.name === name);
    if (!hit) {
      r.warn(BUILTIN_PLUGINS.some((b) => b.name === name) ? `${name} is built into pf and cannot be removed` : `${name} is not installed (pf plugin list)`);
      fails++;
      continue;
    }
    const code = await runCmd({ argv: uninstallArgv(hit.package) }, { dryRun: opts.dryRun, quiet: true });
    if (code !== 0) {
      r.fail(`npm uninstall failed for ${hit.package}`);
      fails++;
    } else if (opts.dryRun) r.info(`would remove ${hit.package}`);
    else {
      // npm leaves an empty scope folder behind; drop it so the folder reflects what is installed
      const scope = path.dirname(hit.dir);
      try {
        if (fs.readdirSync(scope).length === 0) fs.rmdirSync(scope);
      } catch {
        // already gone
      }
      r.ok(`removed ${hit.package}`);
    }
  }
  return fails ? 1 : 0;
}

/**
 * `pf plugin update [name...]` and the plugins step of `pf update`: bring every installed plugin
 * (or the named ones) to the latest version. `check` only reports.
 */
export async function updatePlugins(names: string[], opts: { check?: boolean; dryRun?: boolean } = {}): Promise<number> {
  const r = reporter(out());
  const all = installedPlugins();
  const chosen = names.length ? all.filter((p) => names.includes(p.name)) : all;
  const unknown = names.filter((n) => !all.some((p) => p.name === n));
  for (const n of unknown) r.warn(`${n} is not installed (pf plugin install ${n})`);
  if (!chosen.length) {
    if (!names.length) r.info('no plugins installed from the registry (pf plugin available)');
    return unknown.length ? 1 : 0;
  }
  let fails = 0;
  for (const p of chosen) {
    const found = viewRemote(p.package);
    if (!found.plugin) {
      r.fail(`${p.name}: ${found.error}`);
      fails++;
      continue;
    }
    const latest = found.plugin.version;
    if (p.version && compareVersions(latest, p.version) <= 0) {
      r.ok(`${p.name} v${short(p.version)} is the latest`);
      continue;
    }
    if (opts.check) {
      r.warn(`${p.name} v${short(latest)} is available (you have v${p.version ? short(p.version) : '?'})`);
      continue;
    }
    const code = await runCmd({ argv: installArgv(p.package, latest) }, { dryRun: opts.dryRun, quiet: true });
    if (code !== 0) {
      r.fail(`${p.name}: npm install failed`);
      fails++;
    } else if (opts.dryRun) r.info(`would update ${p.name} to v${short(latest)}`);
    else r.ok(`${p.name} updated to v${short(latest)}${p.version ? ` (was v${short(p.version)})` : ''}`);
  }
  if (fails) r.info(AUTH_HINT);
  return fails || unknown.length ? 1 : 0;
}
