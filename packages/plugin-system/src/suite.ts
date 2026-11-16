import { out } from '@pulpfixer/kit/ui/palette';
import { reporter } from '@pulpfixer/kit/ui/prompt';
import { compareVersions } from '@pulpfixer/kit/util';
import { applyPreset, fetchPackages, installVsix, prepare, short } from './apply.js';
import { findApp } from './apps/index.js';
import { fetchPreset } from './presets.js';

/**
 * The pulpfixer suite: the preset `@pulpfixer/preset-suite` lists the extension packages
 * (`@pulpfixer/ext-<name>`, each a `.vsix`) that go with pf. `pf sys apply suite` installs them into
 * Cursor, `pf update` and `pf sys update` keep the installed ones current, and `pf rp` offers them.
 */
export const SUITE_PRESET = 'suite';
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

/** Apply the suite preset (install what is missing, update what is older). Returns the exit code. */
export async function installSuite(opts: { yes?: boolean; dryRun?: boolean; offline?: boolean } = {}): Promise<number> {
  const target = prepare(SUITE_PRESET, opts.offline ?? false);
  if (!target) return 1;
  return applyPreset(target, { yes: opts.yes ?? false, dryRun: opts.dryRun ?? false });
}

/**
 * Bring the suite extensions that are already installed in Cursor up to the registry's version (the `pf update`
 * step). Never installs a missing one: that is `pf sys apply suite`. `check` only reports. Returns the exit code.
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
  const preset = fetchPreset(SUITE_PRESET, { offline: opts.offline ?? false });
  if ('error' in preset) {
    // The suite is an optional addon: not being able to read it is a warning, not a failed update.
    r.warn(`suite: ${preset.error}`);
    return 0;
  }
  if (preset.note) r.warn(`${preset.note}: using the cached suite`);
  const { packages, errors } = fetchPackages(preset.preset.packages, opts.offline ?? false, () => {});
  for (const e of errors) r.fail(e);
  let fails = errors.length;
  const have = new Set(state.extensions.map((e) => e.toLowerCase()));
  for (const p of packages) {
    const key = p.id.toLowerCase();
    if (!have.has(key)) {
      r.info(`${p.id} is not installed (v${short(p.version)} is available): pf sys apply suite installs it`);
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
