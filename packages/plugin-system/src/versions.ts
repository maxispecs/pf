import { findApp, type AppAdapter } from './apps/index.js';
import { cachedExtensions } from './extensions.js';
import { cachedPresets, presetPackage } from './presets.js';
import { BG_TONE_EXTENSION } from './suite.js';
import { SUITE_PACKAGE, cachedSuite } from './suitefile.js';

/** What the system plugin has on this machine, for `pf versions`. Reads files and the app's extension list; no network. */
export interface SystemVersions {
  /** Presets fetched into `~/.pf/sys/presets`. */
  presets: { name: string; package: string; version: string; problem?: string }[];
  /** The suite package fetched there (`@pulpfixer/suite`); absent when it was never fetched. */
  suite?: { package: string; version: string; features: string[]; problem?: string };
  /** Extension packages fetched there, with what the app has installed. */
  extensions: {
    package: string;
    /** Version of the cached package (the `.vsix` pf would install). */
    version: string;
    /** Extension id inside the app; null when the cached package is unusable. */
    id: string | null;
    /** Version installed in the app; '' when it has no version, null when it is not installed or could not be read. */
    installed: string | null;
    problem?: string;
  }[];
  app: {
    label: string;
    found: boolean;
    /** The extension list could be read (the launcher was found and answered). */
    readable: boolean;
  };
}

type AppProbe = Pick<AppAdapter, 'label' | 'detect' | 'readState'>;

/**
 * Presets and suite extension packages cached on this machine, next to the versions of those extensions
 * installed in Cursor. `app` overrides the app that is read (tests); `null` means "no app".
 */
export function systemVersions(opts: { app?: AppProbe | null } = {}): SystemVersions {
  const app = opts.app === undefined ? (findApp('cursor') ?? null) : opts.app;
  const found = !!app && app.detect();
  const state = found ? app!.readState() : null;
  const versions = state?.extensionVersions ?? null;
  const readable = state?.extensions != null;
  const installedOf = (id: string | null): string | null => {
    if (!id || !readable) return null;
    const key = id.toLowerCase();
    if (versions && key in versions) return versions[key]!;
    return state!.extensions!.some((e) => e.toLowerCase() === key) ? '' : null;
  };

  const extensions: SystemVersions['extensions'] = cachedExtensions().map((e) => ({
    package: e.pkg,
    version: e.version,
    id: e.info?.id ?? null,
    installed: installedOf(e.info?.id ?? null),
    ...(e.problem ? { problem: e.problem } : {}),
  }));
  // Background Tone installed in Cursor from somewhere else (never fetched by this pf) is still part of the suite.
  const installedBgTone = installedOf(BG_TONE_EXTENSION);
  if (installedBgTone !== null && !extensions.some((e) => e.id?.toLowerCase() === BG_TONE_EXTENSION)) {
    extensions.push({ package: '@pulpfixer/ext-bg-tone', version: '', id: BG_TONE_EXTENSION, installed: installedBgTone });
  }

  const suite = cachedSuite();
  return {
    ...(suite
      ? { suite: { package: SUITE_PACKAGE, version: suite.version, features: suite.suite?.features.map((f) => f.id) ?? [], ...(suite.problem ? { problem: suite.problem } : {}) } }
      : {}),
    presets: cachedPresets().map((p) => ({ name: p.name, package: presetPackage(p.name), version: p.version, ...(p.problem ? { problem: p.problem } : {}) })),
    extensions,
    app: { label: app?.label ?? 'Cursor', found, readable },
  };
}
