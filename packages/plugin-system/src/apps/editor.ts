import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from '@pulpfixer/kit/exec';
import { readText, which } from '@pulpfixer/kit/util';
import { parseJsonc } from '../jsonc.js';
import type { AppAdapter, AppState } from './index.js';

/** A VS Code family editor (Cursor, VS Code, ...): same settings.json and extension CLI, different names. */
export interface EditorSpec {
  id: string;
  label: string;
  /** Folder name under the platform's config dir (`Cursor`). */
  configDir: string;
  /** Command line launcher on PATH (`cursor`). */
  cli: string;
  /** Where the macOS app bundle keeps its launcher when it is not on PATH. */
  macCli?: string;
}

/** `<config dir>/User/settings.json` for a platform. */
export function settingsPathFor(
  spec: Pick<EditorSpec, 'configDir'>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return path.join(base, spec.configDir, 'User', 'settings.json');
}

/** The launcher to run: on PATH, else inside the macOS app bundle. */
export function findCli(spec: EditorSpec): string | null {
  const onPath = which(spec.cli);
  if (onPath) return onPath;
  if (spec.macCli && process.platform === 'darwin' && fs.existsSync(spec.macCli)) return spec.macCli;
  return null;
}

/** `--list-extensions`, with `--show-versions` each line is `id@version`. */
export const listExtensionsArgv = (cli: string, withVersions = false): string[] => [cli, '--list-extensions', ...(withVersions ? ['--show-versions'] : [])];
export const installExtensionArgv = (cli: string, id: string): string[] => [cli, '--install-extension', id];
/** Install a `.vsix` file; `--force` replaces an installed version (an update). */
export const installVsixArgv = (cli: string, file: string): string[] => [cli, '--install-extension', file, '--force'];

const ID_LINE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i;
const VERSION_LINE = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*)@(\d+(?:\.\d+){0,3}(?:-[\w.]+)?)$/i;

/** Extension ids from `--list-extensions` (with or without `--show-versions`); other lines (the editor's own log noise) are dropped. */
export function parseExtensions(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim().replace(VERSION_LINE, '$1'))
    .filter((l) => ID_LINE.test(l));
}

/** Installed versions from `--list-extensions --show-versions`, keyed by lowercased id. */
export function parseExtensionVersions(stdout: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = VERSION_LINE.exec(line.trim());
    if (m) found[m[1]!.toLowerCase()] = m[2]!;
  }
  return found;
}

export function editorAdapter(spec: EditorSpec): AppAdapter {
  const settingsPath = (): string => settingsPathFor(spec);
  return {
    id: spec.id,
    label: spec.label,
    settingsPath,
    detect: () => findCli(spec) !== null || fs.existsSync(path.dirname(settingsPath())),
    readState(): AppState {
      const cli = findCli(spec);
      const file = settingsPath();
      const problems: string[] = [];
      let extensions: string[] | null = null;
      let extensionVersions: Record<string, string> | null = null;
      if (!cli) problems.push(`the ${spec.cli} command was not found (extensions cannot be read or installed)`);
      else {
        const r = capture(listExtensionsArgv(cli, true), { timeout: 60_000 });
        const ids = parseExtensions(r.stdout);
        if (r.ok || ids.length) {
          extensions = ids;
          extensionVersions = parseExtensionVersions(r.stdout);
        }
        else problems.push(`${spec.cli} --list-extensions failed${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]}` : ''}`);
      }
      const text = readText(file);
      let settings: Record<string, unknown> | null = null;
      if (text !== null) {
        settings = parseJsonc(text);
        if (!settings) problems.push(`${file} is not a JSON object (fix it by hand first, nothing was changed)`);
      } else settings = {};
      return { cli, extensions, extensionVersions, settingsPath: file, settingsText: text, settings, problems };
    },
    installArgv: (state, id) => (state.cli ? installExtensionArgv(state.cli, id) : null),
    installVsixArgv: (state, file) => (state.cli ? installVsixArgv(state.cli, file) : null),
  };
}
