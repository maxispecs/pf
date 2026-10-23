import type { Command, Entry } from './types.js';
import type { Context } from './context.js';

/** The plugin interface revision this kit implements. pf refuses a plugin that asks for a newer one. */
export const PLUGIN_API = 1;

/**
 * A plugin bundles related commands (and optional menu entries) that live outside the core
 * command set. Built-in ones are packages under `packages/plugin-<name>` listed in core's
 * `src/plugins/index.ts`; users add others from the registry (`pf plugin install <name>`), where a
 * plugin is the package `@pf-plugins/<name>` whose entry point default-exports a `Plugin`.
 */
export interface Plugin {
  name: string;
  /** Plugin interface revision the plugin was written for (default 1). */
  api?: number;
  summary: string;
  commands: Command[];
  /** Entries this plugin adds to the `pf` menu and `pf list`. */
  entries?(ctx: Context): Entry[];
}
