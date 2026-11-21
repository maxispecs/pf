/**
 * The Obsidian part of a preset (`"app": "obsidian"`): data that lands in a vault's `.obsidian` folder.
 * Never code, and nothing here installs a plugin: pf only configures what the vault already has.
 */
export interface Hotkey {
  modifiers: string[];
  key: string;
}

export interface ObsidianConfig {
  /** Keys of `app.json`. */
  app: Record<string, unknown>;
  /** Keys of `appearance.json` (`cssTheme` names a theme folder). */
  appearance: Record<string, unknown>;
  /** `core-plugins.json` flags. */
  corePlugins: Record<string, boolean>;
  /** Community plugin ids to enable (`community-plugins.json`), only when the vault has them installed. */
  communityPlugins: string[];
  /** `hotkeys.json`, by `<plugin id>:<command id>`. */
  hotkeys: Record<string, Hotkey[]>;
  /** Keys merged into `plugins/<id>/data.json`, only when the vault has that plugin installed. */
  pluginSettings: Record<string, Record<string, unknown>>;
}

export const OBSIDIAN_KEYS = ['app', 'appearance', 'corePlugins', 'communityPlugins', 'hotkeys', 'pluginSettings'] as const;

/** Plugin and core plugin ids are folder names in the vault: lowercase letters, digits and dashes. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;
/** `<plugin id>:<command id>` as `hotkeys.json` keys it. */
const COMMAND_ID = /^[a-z0-9][a-z0-9-]*:[A-Za-z0-9_.-]+$/;
/** A theme is a folder under `.obsidian/themes`: a plain name, no separators. */
export const THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const MODIFIERS = new Set(['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt']);

export const emptyObsidianConfig = (): ObsidianConfig => ({ app: {}, appearance: {}, corePlugins: {}, communityPlugins: [], hotkeys: {}, pluginSettings: {} });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reject keys that would reach the prototype, at any depth. Returns the offending key. */
function unsafeKey(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const bad = unsafeKey(x);
      if (bad) return bad;
    }
  } else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') return k || '(empty)';
      const bad = unsafeKey(x);
      if (bad) return bad;
    }
  }
  return null;
}

function settingsObject(value: unknown, where: string): Record<string, unknown> | string {
  if (!isObject(value)) return `"${where}" must be an object`;
  const bad = unsafeKey(value);
  if (bad) return `"${bad}" is not a settings key (in ${where})`;
  return value;
}

/** Check the `obsidian` section of a `preset.json`. Returns the config, or why it is unusable. */
export function validateObsidianConfig(value: unknown): ObsidianConfig | string {
  if (!isObject(value)) return '"obsidian" must be an object';
  for (const k of Object.keys(value)) {
    if (!(OBSIDIAN_KEYS as readonly string[]).includes(k)) return `"obsidian.${k}" is not a known section (${OBSIDIAN_KEYS.join(', ')})`;
  }
  const cfg = emptyObsidianConfig();

  for (const key of ['app', 'appearance'] as const) {
    if (value[key] === undefined) continue;
    const got = settingsObject(value[key], `obsidian.${key}`);
    if (typeof got === 'string') return got;
    cfg[key] = got;
  }
  const theme = cfg.appearance.cssTheme;
  if (theme !== undefined && theme !== '' && (typeof theme !== 'string' || !THEME_NAME.test(theme) || theme.includes('..'))) {
    return '"obsidian.appearance.cssTheme" must be a plain theme name';
  }

  if (value.corePlugins !== undefined) {
    if (!isObject(value.corePlugins)) return '"obsidian.corePlugins" must be an object of id: true|false';
    for (const [id, on] of Object.entries(value.corePlugins)) {
      if (!PLUGIN_ID.test(id)) return `"${id}" is not a core plugin id`;
      if (typeof on !== 'boolean') return `obsidian.corePlugins.${id} must be true or false`;
      cfg.corePlugins[id] = on;
    }
  }

  if (value.communityPlugins !== undefined) {
    if (!Array.isArray(value.communityPlugins)) return '"obsidian.communityPlugins" must be an array of plugin ids';
    for (const id of value.communityPlugins) {
      if (typeof id !== 'string' || !PLUGIN_ID.test(id)) return `"${String(id)}" is not a community plugin id`;
      if (!cfg.communityPlugins.includes(id)) cfg.communityPlugins.push(id);
    }
  }

  if (value.hotkeys !== undefined) {
    if (!isObject(value.hotkeys)) return '"obsidian.hotkeys" must be an object';
    for (const [cmd, list] of Object.entries(value.hotkeys)) {
      if (!COMMAND_ID.test(cmd)) return `"${cmd}" is not a command id (<plugin id>:<command>)`;
      if (!Array.isArray(list)) return `obsidian.hotkeys.${cmd} must be an array`;
      const keys: Hotkey[] = [];
      for (const h of list) {
        if (!isObject(h) || typeof h.key !== 'string' || !h.key || !Array.isArray(h.modifiers) || !h.modifiers.every((m) => typeof m === 'string' && MODIFIERS.has(m))) {
          return `obsidian.hotkeys.${cmd} needs { "modifiers": [Mod|Ctrl|Meta|Shift|Alt], "key" }`;
        }
        keys.push({ modifiers: h.modifiers as string[], key: h.key });
      }
      cfg.hotkeys[cmd] = keys;
    }
  }

  if (value.pluginSettings !== undefined) {
    if (!isObject(value.pluginSettings)) return '"obsidian.pluginSettings" must be an object';
    for (const [id, settings] of Object.entries(value.pluginSettings)) {
      if (!PLUGIN_ID.test(id)) return `"${id}" is not a plugin id`;
      const got = settingsObject(settings, `obsidian.pluginSettings.${id}`);
      if (typeof got === 'string') return got;
      cfg.pluginSettings[id] = got;
    }
  }
  return cfg;
}
