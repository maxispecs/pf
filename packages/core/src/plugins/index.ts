import type { Command, Entry } from '@pulpfixer/kit/types';
import type { Context } from '@pulpfixer/kit/context';
import { awsPlugin } from '@pulpfixer/plugin-aws';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { loadedPlugins } from './loader.js';

/** Plugins that ship inside pf. A new one is one import and one line here. */
export const BUILTIN_PLUGINS: Plugin[] = [awsPlugin];

/** Built-in plugins, then the ones installed from the registry (loaded at startup). */
export function activePlugins(): Plugin[] {
  return [...BUILTIN_PLUGINS, ...loadedPlugins().map((l) => l.plugin)];
}

export function pluginCommands(): Command[] {
  return activePlugins().flatMap((p) => p.commands);
}

export function pluginEntries(ctx: Context): Entry[] {
  return activePlugins().flatMap((p) => {
    try {
      return p.entries?.(ctx) ?? [];
    } catch {
      return []; // a broken plugin must not take the menu down
    }
  });
}
