import { cursorApp } from './cursor.js';

/** What an app looks like on this machine right now. */
export interface AppState {
  /** The command line launcher, when found. */
  cli: string | null;
  /** Installed extension ids; null when they could not be read. */
  extensions: string[] | null;
  /** Installed versions by lowercased id (`--show-versions`); null when the extensions could not be read. */
  extensionVersions: Record<string, string> | null;
  settingsPath: string;
  /** Raw settings file; null when it does not exist. */
  settingsText: string | null;
  /** Parsed settings (empty when the file is missing); null when the file is not a JSON object. */
  settings: Record<string, unknown> | null;
  /** Things that stop part of a preset from applying, worded for the user. */
  problems: string[];
}

/** An app a preset can configure. A new app is one file here and one line in `APPS`. */
export interface AppAdapter {
  id: string;
  label: string;
  settingsPath(): string;
  /** True when the app seems to be installed here. */
  detect(): boolean;
  readState(): AppState;
  /** The command that installs one extension; null when the app has no launcher. */
  installArgv(state: AppState, id: string): string[] | null;
  /** The command that installs (or replaces) an extension from a `.vsix` file; null when the app has no launcher. */
  installVsixArgv(state: AppState, file: string): string[] | null;
}

export const APPS: AppAdapter[] = [cursorApp];

export const findApp = (id: string): AppAdapter | undefined => APPS.find((a) => a.id === id);
