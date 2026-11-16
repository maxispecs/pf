import type { Palette } from '@pulpfixer/kit/ui/palette';
import { compareVersions } from '@pulpfixer/kit/util';
import type { ExtensionInfo } from './extensions.js';
import { sameJson } from './jsonc.js';
import type { Preset } from './presets.js';

export interface SettingChange {
  key: string;
  /** Current value; undefined when the key is not set. */
  from: unknown;
  to: unknown;
}

/** An extension package whose `.vsix` is to be installed or updated. */
export interface VsixChange {
  pkg: string;
  id: string;
  /** Installed version; null when the extension is not installed. */
  installed: string | null;
  latest: string;
  file: string;
}

/** What applying a preset would change. Additive only: nothing is uninstalled, other settings stay. */
export interface Plan {
  /** Extensions from the preset that are not installed. */
  install: string[];
  /** Settings that are missing or have another value. */
  settings: SettingChange[];
  /** Extension packages whose `.vsix` is missing or older than the registry's. */
  vsix: VsixChange[];
  /** Extension packages already at the registry's version (or newer), for the summary line. */
  vsixOk: number;
  /** Counts that already match, for the summary line. */
  extensionsOk: number;
  settingsOk: number;
}

/**
 * Compare a preset with what an app has now. `extensions` null (unreadable) plans no installs.
 * `packages` are the fetched extension packages of the preset: each is installed when missing and
 * updated when the app has an older version (a newer one is left alone).
 */
export function planPreset(
  preset: Preset,
  state: { extensions: string[] | null; settings: Record<string, unknown>; extensionVersions?: Record<string, string> | null },
  packages: ExtensionInfo[] = [],
): Plan {
  const have = new Set((state.extensions ?? []).map((e) => e.toLowerCase()));
  const install = state.extensions === null ? [] : preset.extensions.filter((e) => !have.has(e.toLowerCase()));
  const settings: SettingChange[] = [];
  let settingsOk = 0;
  for (const [key, to] of Object.entries(preset.settings)) {
    const from = Object.prototype.hasOwnProperty.call(state.settings, key) ? state.settings[key] : undefined;
    if (from !== undefined && sameJson(from, to)) settingsOk++;
    else settings.push({ key, from, to });
  }
  const vsix: VsixChange[] = [];
  let vsixOk = 0;
  if (state.extensions !== null) {
    for (const p of packages) {
      const key = p.id.toLowerCase();
      const installed = state.extensionVersions?.[key];
      // Installed with no readable version: leave it alone rather than reinstall on every run.
      if (!have.has(key)) vsix.push({ pkg: p.pkg, id: p.id, installed: null, latest: p.version, file: p.file });
      else if (installed && compareVersions(p.version, installed) > 0) vsix.push({ pkg: p.pkg, id: p.id, installed, latest: p.version, file: p.file });
      else vsixOk++;
    }
  }
  return {
    install,
    settings,
    vsix,
    vsixOk,
    extensionsOk: state.extensions === null ? 0 : preset.extensions.length - install.length,
    settingsOk,
  };
}

export const isEmptyPlan = (p: Plan): boolean => p.install.length === 0 && p.settings.length === 0 && p.vsix.length === 0;

/** The settings the plan changes, as the object to write. */
export function settingsToWrite(plan: Plan): Record<string, unknown> {
  return Object.fromEntries(plan.settings.map((s) => [s.key, s.to]));
}

const show = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

/** Human lines for a plan, for diff, apply and --dry-run. */
export function describePlan(plan: Plan, c: Palette): string[] {
  const lines: string[] = [];
  if (plan.install.length) {
    lines.push(c.bold(`Extensions to install (${plan.install.length})`));
    for (const e of plan.install) lines.push(`  ${c.green('+')} ${e}`);
  }
  if (plan.settings.length) {
    lines.push(c.bold(`Settings to change (${plan.settings.length})`));
    for (const s of plan.settings) {
      lines.push(
        s.from === undefined
          ? `  ${c.green('+')} ${s.key}: ${show(s.to)}`
          : `  ${c.yellow('~')} ${s.key}: ${c.dim(show(s.from))} ${c.dim('->')} ${show(s.to)}`,
      );
    }
  }
  if (plan.vsix.length) {
    lines.push(c.bold(`Suite extensions to install or update (${plan.vsix.length})`));
    for (const v of plan.vsix) {
      lines.push(
        v.installed === null
          ? `  ${c.green('+')} ${v.id} ${c.dim(`v${v.latest} (${v.pkg})`)}`
          : `  ${c.yellow('~')} ${v.id} ${c.dim(`v${v.installed} ->`)} v${v.latest}`,
      );
    }
  }
  const ok = [
    plan.vsixOk ? `${plan.vsixOk} suite extension${plan.vsixOk === 1 ? '' : 's'}` : '',
    plan.extensionsOk ? `${plan.extensionsOk} extension${plan.extensionsOk === 1 ? '' : 's'}` : '',
    plan.settingsOk ? `${plan.settingsOk} setting${plan.settingsOk === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  if (ok.length) lines.push(c.dim(`already in place: ${ok.join(', ')}`));
  return lines;
}

/** A preset.json built from what an app has now, for refreshing a preset package. */
export function capturePreset(
  app: string,
  label: string,
  state: { extensions: string[]; settings: Record<string, unknown> },
  keys: string[],
): { preset: Preset; missing: string[] } {
  const settings: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(state.settings, k)) settings[k] = state.settings[k];
    else missing.push(k);
  }
  const extensions = [...state.extensions].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { preset: { app, summary: `Standard ${label} setup`, extensions, settings, packages: [] }, missing };
}
