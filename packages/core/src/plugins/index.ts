import type { Command, Entry } from '@pulpfixer/kit/types';
import type { Context } from '@pulpfixer/kit/context';
import { awsPlugin } from '@pulpfixer/plugin-aws';
import type { Plugin } from '@pulpfixer/kit/plugin';

/** Every built-in plugin. A new plugin is one import and one line here. */
export const PLUGINS: Plugin[] = [awsPlugin];

export function pluginCommands(): Command[] {
  return PLUGINS.flatMap((p) => p.commands);
}

export function pluginEntries(ctx: Context): Entry[] {
  return PLUGINS.flatMap((p) => p.entries?.(ctx) ?? []);
}
