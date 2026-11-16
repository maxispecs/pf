import fs from 'node:fs';
import path from 'node:path';
import { captureAsync, runCmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { confirm, reporter } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel } from '@pulpfixer/kit/ui/text';
import { interactive } from '@pulpfixer/kit/util';
import { APPS, findApp, type AppAdapter, type AppState } from './apps/index.js';
import { fetchExtension, type ExtensionInfo } from './extensions.js';
import { parseJsonc, sameJson, setTopLevelKeys } from './jsonc.js';
import { describePlan, isEmptyPlan, planPreset, settingsToWrite, type Plan, type VsixChange } from './plan.js';
import { fetchPreset, presetPackage, type FetchedPreset } from './presets.js';

export const short = (v: string): string => v.replace(/^(\d+\.\d+)\.0$/, '$1');

export function fail(message: string): number {
  process.stderr.write(`${badgeLabel('error', err())} ${message}\n`);
  return 1;
}

export interface Target {
  fetched: FetchedPreset;
  app: AppAdapter;
  state: AppState;
  settings: Record<string, unknown>;
  /** The preset's extension packages that could be fetched. */
  packages: ExtensionInfo[];
  /** Extension packages that could not be fetched (worded for the user); applying reports them and exits 1. */
  packageErrors: string[];
  plan: Plan;
}

/** Fetch every extension package of a preset. Failures are collected, not fatal, so the rest still applies. */
export function fetchPackages(names: string[], offline: boolean, say: (title: string, where: string) => void): { packages: ExtensionInfo[]; errors: string[] } {
  const packages: ExtensionInfo[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const got = fetchExtension(name, { offline });
    if ('error' in got) {
      errors.push(got.error);
      continue;
    }
    const where = got.source === 'registry' ? `latest from the registry${got.previous ? `, was v${short(got.previous)}` : ''}` : 'cached copy';
    say(`${name} v${short(got.info.version)}`, where);
    if (got.note) process.stderr.write(`${badgeLabel('warning', err())} ${got.note}: using the cached copy\n`);
    packages.push(got.info);
  }
  return { packages, errors };
}

/** Fetch a preset, read the app it configures and work out the plan. Prints why when it cannot. */
export function prepare(name: string, offline: boolean): Target | null {
  const c = out();
  const fetched = fetchPreset(name, { offline });
  if ('error' in fetched) {
    fail(fetched.error);
    return null;
  }
  const where = fetched.source === 'registry' ? `latest from the registry${fetched.previous ? `, was v${short(fetched.previous)}` : ''}` : 'cached copy';
  process.stdout.write(`${c.bold(`${presetPackage(name)} v${short(fetched.version)}`)} ${c.dim(`(${where})`)}\n`);
  if (fetched.note) process.stderr.write(`${badgeLabel('warning', err())} ${fetched.note}: using the cached copy\n`);
  const app = findApp(fetched.preset.app);
  if (!app) {
    fail(`this pf has no adapter for "${fetched.preset.app}" (apps: ${APPS.map((a) => a.id).join(', ')}). Run: pf update`);
    return null;
  }
  if (!app.detect()) {
    fail(`${app.label} does not seem to be installed here (looked for ${app.settingsPath()})`);
    return null;
  }
  const state = app.readState();
  if (state.settings === null) {
    for (const p of state.problems) fail(p);
    return null;
  }
  for (const p of state.problems) process.stderr.write(`${badgeLabel('warning', err())} ${p}\n`);
  const { packages, errors } = fetchPackages(fetched.preset.packages, offline, (title, how) => process.stdout.write(`${c.bold(title)} ${c.dim(`(${how})`)}\n`));
  const plan = planPreset(fetched.preset, { extensions: state.extensions, extensionVersions: state.extensionVersions, settings: state.settings }, packages);
  return { fetched, app, state, settings: state.settings, packages, packageErrors: errors, plan };
}

/** Write the plan's settings into the app's settings file, keeping a backup of the old one. */
function writeSettings(t: Target): { ok: true; backup: string | null } | { ok: false; error: string } {
  const file = t.state.settingsPath;
  const entries = settingsToWrite(t.plan);
  const next = setTopLevelKeys(t.state.settingsText ?? '', entries);
  const parsed = next === null ? null : parseJsonc(next);
  if (next === null || !parsed || !Object.entries(entries).every(([k, v]) => sameJson(parsed[k], v))) {
    return { ok: false, error: `could not edit ${file} safely, nothing was written` };
  }
  let backup: string | null = null;
  try {
    if (t.state.settingsText !== null) {
      backup = `${file}.pf-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, backup);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
  } catch (e) {
    return { ok: false, error: `could not write ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, backup };
}

/** What a marketplace install or a `.vsix` install printed, judged: the editor CLI exits 0 even when it failed. */
function installFailed(res: { code: number; output: string }): boolean {
  return res.code !== 0 || /not found|failed installing/i.test(res.output);
}

const lastLineOf = (output: string): string => output.trim().split('\n').filter(Boolean).pop() ?? '';

/** Install or update one suite extension from its `.vsix`. Returns an error message, or null. */
export async function installVsix(app: AppAdapter, state: AppState, v: VsixChange): Promise<string | null> {
  const argv = app.installVsixArgv(state, v.file);
  if (!argv) return `${v.id}: ${app.label} has no command line launcher, skipped`;
  const res = await captureAsync({ argv }, { timeout: 5 * 60_000, maxBytes: 4_000 });
  return installFailed(res) ? `${v.id}: ${lastLineOf(res.output) || `exit ${res.code}`}` : null;
}

export async function applyPreset(t: Target, o: { yes: boolean; dryRun: boolean }): Promise<number> {
  const c = out();
  const r = reporter(c);
  const w = (s: string) => process.stdout.write(s + '\n');
  const { plan, app } = t;
  for (const line of describePlan(plan, c)) w(line);
  for (const e of t.packageErrors) r.fail(e);
  if (isEmptyPlan(plan)) {
    if (t.packageErrors.length) return 1;
    r.ok(`${app.label} already matches the preset`);
    return 0;
  }
  if ((plan.install.length || plan.vsix.length) && t.state.extensions === null) r.warn('extensions are skipped: they could not be read');

  if (o.dryRun) {
    for (const id of plan.install) {
      const argv = app.installArgv(t.state, id);
      if (argv) await runCmd({ argv }, { dryRun: true });
    }
    for (const v of plan.vsix) {
      const argv = app.installVsixArgv(t.state, v.file);
      if (argv) await runCmd({ argv }, { dryRun: true });
    }
    if (plan.settings.length) r.info(`would set ${plan.settings.length} setting${plan.settings.length === 1 ? '' : 's'} in ${t.state.settingsPath} (a backup is kept)`);
    return t.packageErrors.length ? 1 : 0;
  }

  if (!o.yes) {
    const yes = await confirm(`Apply to ${app.label}?`, false, { flag: '--yes' });
    if (!yes) {
      r.info('nothing changed');
      return interactive() ? 0 : 1;
    }
  }

  let fails = t.packageErrors.length;
  if (plan.settings.length) {
    const res = writeSettings(t);
    if (res.ok) {
      r.ok(`set ${plan.settings.length} setting${plan.settings.length === 1 ? '' : 's'} in ${t.state.settingsPath}`);
      if (res.backup) r.info(`previous file kept as ${res.backup}`);
    } else {
      r.fail(res.error);
      fails++;
    }
  }
  for (const id of plan.install) {
    const argv = app.installArgv(t.state, id);
    if (!argv) {
      r.warn(`${id}: ${app.label} has no command line launcher, skipped`);
      fails++;
      continue;
    }
    r.step(`installing ${id}`);
    const res = await captureAsync({ argv }, { timeout: 5 * 60_000, maxBytes: 4_000 });
    if (installFailed(res)) {
      r.fail(`${id}: ${lastLineOf(res.output) || `exit ${res.code}`}`);
      fails++;
    } else r.ok(id);
  }
  let vsixDone = 0;
  for (const v of plan.vsix) {
    r.step(`${v.installed === null ? 'installing' : 'updating'} ${v.id} v${v.latest}`);
    const problem = await installVsix(app, t.state, v);
    if (problem) {
      r.fail(problem);
      fails++;
    } else {
      r.ok(`${v.id} v${v.latest}`);
      vsixDone++;
    }
  }
  w('');
  if (fails) r.fail(`${fails} step${fails === 1 ? '' : 's'} failed`);
  else r.ok(`${app.label} now matches ${presetPackage(t.fetched.name)} v${short(t.fetched.version)}`);
  if (vsixDone) r.info(`reload the ${app.label} window (Developer: Reload Window) to use the new extension version${vsixDone === 1 ? '' : 's'}`);
  return fails ? 1 : 0;
}
