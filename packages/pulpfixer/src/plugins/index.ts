import type { Tool } from '@pulpfixer/kit/agent-tool';
import type { Command, Entry } from '@pulpfixer/kit/types';
import type { Context } from '@pulpfixer/kit/context';
import { awsPlugin } from '@pulpfixer/plugin-aws';
import { criPlugin } from '@pulpfixer/plugin-cri';
import { csvPlugin } from '@pulpfixer/plugin-csv';
import { dbPlugin } from '@pulpfixer/plugin-db';
import { ioPlugin } from '@pulpfixer/plugin-io';
import { pdfPlugin } from '@pulpfixer/plugin-pdf';
import { systemPlugin } from '@pulpfixer/plugin-system';
import { yubikeyPlugin } from '@pulpfixer/plugin-yubikey';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { TOOLS } from '../agent/tools.js';
import { loadedPlugins } from './loader.js';

/** Plugins that ship inside pf. A new one is one import and one line here. */
export const BUILTIN_PLUGINS: Plugin[] = [awsPlugin, criPlugin, yubikeyPlugin, systemPlugin, dbPlugin, ioPlugin, csvPlugin, pdfPlugin];

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

export function pluginTools(ctx: Context): Tool[] {
  return activePlugins().flatMap((p) => {
    try {
      return p.tools?.(ctx) ?? [];
    } catch {
      return [];
    }
  });
}

/** Every tool `pf mcp` serves for a repo: the built-in ones, then plugin tools that do not reuse a name. */
export function agentTools(ctx: Context): Tool[] {
  const seen = new Set<string>();
  return [...TOOLS, ...pluginTools(ctx)].filter((t) => !seen.has(t.name) && !!seen.add(t.name));
}
