import path from 'node:path';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { reporter } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel } from '@pulpfixer/kit/ui/text';
import { compareVersions, interactive } from '@pulpfixer/kit/util';
import { applyPreset, fail, fetchPackages, installVsix, prepareFetched, sayFetched, short } from './apply.js';
import { findApp } from './apps/index.js';
import { cachedExtension } from './extensions.js';
import { applyObsidian } from './obsidian/apply.js';
import { detectObsidian, listVaults, obsidianConfigDir, resolveVault } from './obsidian/vaults.js';
import { cachedPreset, fetchPreset } from './presets.js';
import { SUITE_PACKAGE, fetchSuite, featureOf, type FetchedSuite, type Suite, type SuiteFeature } from './suitefile.js';
import { readSuiteState, recordEnabled } from './suitestate.js';

/**
 * The pulpfixer suite: `@pulpfixer/suite` lists the features that go with pf (`suite.json`). `pf suite enable`
 * applies them (the default ones with no name, an optional one when named), `pf update` and `pf sys update` keep
 * the Cursor extensions that are already installed current, and `pf rp` offers them.
 */
export const CURSOR_FEATURE = 'cursor';
/** The Background Tone extension: its id inside Cursor. */
export const BG_TONE_EXTENSION = 'local.bg-tone';

export interface BgToneStatus {
  /** Cursor (its settings folder or `cursor` command) was found. */
  cursor: boolean;
  /** The `cursor` command was found, so extensions can be listed and installed. */
  cli: boolean;
  /** Installed version of the Background Tone extension; null when it is not installed (or could not be read). */
  installed: string | null;
  /** The extension list could not be read. */
  unknown: boolean;
}

/** Is Background Tone in Cursor? Reads Cursor's extension list only, no network. */
export function bgToneStatus(): BgToneStatus {
  const app = findApp('cursor');
  if (!app || !app.detect()) return { cursor: false, cli: false, installed: null, unknown: false };
  const state = app.readState();
  if (state.extensions === null) return { cursor: true, cli: state.cli !== null, installed: null, unknown: true };
  const have = state.extensions.some((e) => e.toLowerCase() === BG_TONE_EXTENSION);
  return { cursor: true, cli: state.cli !== null, installed: have ? (state.extensionVersions?.[BG_TONE_EXTENSION] ?? '') : null, unknown: false };
}

/** Fetch the suite (latest, else the cached copy) and say which one it is. Prints why and returns null when it cannot. */
export function loadSuite(offline: boolean, quiet = false): FetchedSuite | null {
  const got = fetchSuite({ offline });
  if ('error' in got) {
    fail(got.error);
    return null;
  }
  if (!quiet) {
    const c = out();
    const where = got.source === 'registry' ? `latest from the registry${got.previous ? `, was v${short(got.previous)}` : ''}` : 'cached copy';
    process.stdout.write(`${c.bold(`${SUITE_PACKAGE} v${short(got.version)}`)} ${c.dim(`(${where})`)}\n`);
  }
  if (got.note) process.stderr.write(`${badgeLabel('warning', err())} ${got.note}: using the cached copy\n`);
  return got;
}

export type FeatureState = 'on' | 'partial' | 'off' | 'unavailable';

export interface FeatureStatus {
  feature: SuiteFeature;
  state: FeatureState;
  /** What the state is based on, worded for the user (`2 vaults`, `Background Tone v0.10`). */
  detail: string;
}

/** The app a feature's preset configures: from the cached preset, else the preset's name. */
function appOf(feature: SuiteFeature): string {
  return cachedPreset(feature.preset)?.preset?.app ?? feature.preset;
}

/** Where each feature stands on this machine. Reads files and Cursor's extension list; no network. */
export function featureStatuses(suite: Suite): FeatureStatus[] {
  const saved = readSuiteState();
  return suite.features.map((feature): FeatureStatus => {
    const appId = appOf(feature);
    if (appId === 'obsidian') {
      if (!detectObsidian()) return { feature, state: 'unavailable', detail: `Obsidian not found here (${obsidianConfigDir()})` };
      const have = saved.features[feature.id]?.targets ?? [];
      return have.length
        ? { feature, state: 'on', detail: `applied to ${have.length} vault${have.length === 1 ? '' : 's'}: ${have.map((v) => path.basename(v)).join(', ')}` }
        : { feature, state: 'off', detail: 'not applied to any vault yet' };
    }
    const app = findApp(appId);
    if (!app) return { feature, state: 'unavailable', detail: `this pf has no adapter for ${appId}` };
    if (!app.detect()) return { feature, state: 'unavailable', detail: `${app.label} not found here` };
    if (!feature.packages.length) return { feature, state: 'off', detail: `${app.label} found` };
    const state = app.readState();
    if (state.extensions === null) return { feature, state: 'unavailable', detail: state.problems[0] ?? `${app.label} extensions could not be read` };
    const have = new Set(state.extensions.map((e) => e.toLowerCase()));
    // the extension id inside the app comes from the fetched package; Background Tone's is known without it
    const ids = feature.packages.map((p) => cachedExtension(p)?.info?.id ?? (p === '@pulpfixer/ext-bg-tone' ? BG_TONE_EXTENSION : null));
    const names = feature.packages.map((p) => p.replace(/^@pulpfixer\/ext-/, ''));
    const present = ids.filter((id) => id !== null && have.has(id.toLowerCase())).length;
    if (present === ids.length) return { feature, state: 'on', detail: `${names.join(', ')} installed in ${app.label}` };
    if (present > 0) return { feature, state: 'partial', detail: `${present} of ${ids.length} extensions installed in ${app.label}` };
    return { feature, state: 'off', detail: `${names.join(', ')} not installed in ${app.label}` };
  });
}

type VaultChoice = { path: string } | { code: number };

/** `--vault`, else a picker in a terminal. Without either it says which vaults exist and asks for the flag (exit 2). */
async function chooseVault(flag: string | undefined): Promise<VaultChoice> {
  const list = listVaults();
  const c = out();
  if (flag !== undefined) {
    const got = resolveVault(flag, list.vaults);
    if (typeof got === 'string') {
      fail(got);
      return { code: 2 };
    }
    return got;
  }
  const usable = list.vaults.filter((v) => v.exists && v.configured);
  if (!usable.length) return { code: fail(list.problem ?? 'Obsidian lists no vault that is still on disk (open one in Obsidian first, or pass --vault <path>)') };
  if (!interactive()) {
    fail('which vault? pass --vault <path or name> (no terminal to ask in)');
    for (const v of usable) process.stderr.write(`    ${c.dim(v.path)}\n`);
    return { code: 2 };
  }
  const chosen = await pick(
    'Which Obsidian vault?',
    usable.map((v) => ({ value: v.path, label: path.basename(v.path), hint: `${v.path}${v.open ? '  (open)' : ''}` })),
  );
  if (!chosen) {
    process.stdout.write(`${c.dim('nothing changed')}\n`);
    return { code: 0 };
  }
  return { path: chosen };
}

export interface EnableOptions {
  yes?: boolean;
  dryRun?: boolean;
  offline?: boolean;
  /** Obsidian: the vault (path or name). */
  vault?: string;
}

/** Turn one suite feature on: its preset (and extension packages) applied to the app it configures. Returns the exit code. */
export async function enableFeature(feature: SuiteFeature, opts: EnableOptions = {}): Promise<number> {
  const offline = opts.offline ?? false;
  const first = fetchPreset(feature.preset, { offline });
  if ('error' in first) return fail(first.error);

  if (first.preset.app === 'obsidian') {
    sayFetched(first);
    const cfg = first.preset.obsidian;
    if (!cfg) return fail(`${feature.preset} has no obsidian section`);
    if (!detectObsidian()) return fail(`Obsidian does not seem to be installed here (looked for ${obsidianConfigDir()})`);
    const vault = await chooseVault(opts.vault);
    if ('code' in vault) return vault.code;
    const run = await applyObsidian(cfg, vault.path, { yes: opts.yes ?? false, dryRun: opts.dryRun ?? false });
    if (run.applied && !opts.dryRun) {
      const problem = recordEnabled(feature.id, vault.path, first.version);
      if (problem) process.stderr.write(`${badgeLabel('warning', err())} ${problem}\n`);
    }
    return run.code;
  }

  const target = prepareFetched(first, offline, { packages: feature.packages });
  if (!target) return 1;
  return applyPreset(target, { yes: opts.yes ?? false, dryRun: opts.dryRun ?? false });
}

/** `pf suite enable <ids>`: the named features, or with none the default (non-optional) ones. Returns the exit code. */
export async function enableFeatures(ids: string[], opts: EnableOptions = {}): Promise<number> {
  const suite = loadSuite(opts.offline ?? false);
  if (!suite) return 1;
  const chosen: SuiteFeature[] = [];
  for (const id of ids) {
    const f = featureOf(suite.suite, id);
    if (!f) {
      process.stderr.write(`${badgeLabel('error', err())} no feature "${id}" in the suite (${suite.suite.features.map((x) => x.id).join(', ')})\n`);
      return 2;
    }
    if (!chosen.includes(f)) chosen.push(f);
  }
  if (!chosen.length) chosen.push(...suite.suite.features.filter((f) => !f.optional));
  if (!chosen.length) return fail('the suite has no default features: name one (pf suite)');
  let code = 0;
  for (const f of chosen) {
    process.stdout.write(`\n${out().bold(`${f.id}`)} ${out().dim(f.summary)}\n`);
    const done = await enableFeature(f, opts);
    if (done !== 0) code = done === 2 ? 2 : Math.max(code, done);
  }
  return code;
}

/** Apply the default features of the suite (the Cursor setup). `pf sys apply suite` and the install one-liner. Returns the exit code. */
export async function installSuite(opts: { yes?: boolean; dryRun?: boolean; offline?: boolean } = {}): Promise<number> {
  return enableFeatures([], opts);
}

/**
 * Bring the suite extensions that are already installed in Cursor up to the registry's version (the `pf update`
 * step). Never installs a missing one: that is `pf suite enable cursor`. `check` only reports. Returns the exit code.
 */
export async function updateSuiteExtensions(opts: { check?: boolean; dryRun?: boolean; offline?: boolean } = {}): Promise<number> {
  const r = reporter(out());
  const app = findApp('cursor');
  if (!app || !app.detect()) {
    r.info('Cursor not found here: no suite extensions to update');
    return 0;
  }
  const state = app.readState();
  if (state.extensions === null) {
    for (const p of state.problems) r.warn(p);
    return 0;
  }
  const suite = fetchSuite({ offline: opts.offline ?? false });
  if ('error' in suite) {
    // The suite is an optional addon: not being able to read it is a warning, not a failed update.
    r.warn(`suite: ${suite.error}`);
    return 0;
  }
  if (suite.note) r.warn(`${suite.note}: using the cached suite`);
  const names = featureOf(suite.suite, CURSOR_FEATURE)?.packages ?? [];
  const { packages, errors } = fetchPackages(names, opts.offline ?? false, () => {});
  for (const e of errors) r.fail(e);
  let fails = errors.length;
  const have = new Set(state.extensions.map((e) => e.toLowerCase()));
  for (const p of packages) {
    const key = p.id.toLowerCase();
    if (!have.has(key)) {
      r.info(`${p.id} is not installed (v${short(p.version)} is available): pf suite enable cursor installs it`);
      continue;
    }
    const installed = state.extensionVersions?.[key];
    if (!installed || compareVersions(p.version, installed) <= 0) {
      r.ok(`${p.id} is current${installed ? ` (v${short(installed)})` : ''}`);
      continue;
    }
    const change = { pkg: p.pkg, id: p.id, installed, latest: p.version, file: p.file };
    if (opts.check) {
      r.info(`${p.id} v${short(installed)} can update to v${short(p.version)}`);
      continue;
    }
    if (opts.dryRun) {
      const argv = app.installVsixArgv(state, p.file);
      r.info(`would update ${p.id} v${short(installed)} -> v${short(p.version)}${argv ? `: ${argv.join(' ')}` : ''}`);
      continue;
    }
    const problem = await installVsix(app, state, change);
    if (problem) {
      r.fail(problem);
      fails++;
    } else r.ok(`updated ${p.id} v${short(installed)} -> v${short(p.version)} (reload the Cursor window to use it)`);
  }
  return fails ? 1 : 0;
}
