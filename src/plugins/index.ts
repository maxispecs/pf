import type { Command, Entry } from '../commands/types.js';
import type { Context } from '../context.js';
import { awsPlugin } from './aws/index.js';
import type { Plugin } from './types.js';

/** Every built-in plugin. A new plugin is one import and one line here. */
export const PLUGINS: Plugin[] = [awsPlugin];

export function pluginCommands(): Command[] {
  return PLUGINS.flatMap((p) => p.commands);
}

export function pluginEntries(ctx: Context): Entry[] {
  return PLUGINS.flatMap((p) => p.entries?.(ctx) ?? []);
}
