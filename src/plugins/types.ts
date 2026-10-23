import type { Command, Entry } from '../commands/types.js';
import type { Context } from '../context.js';

/**
 * A plugin bundles related commands (and optional menu entries) that live outside the core
 * command set. Add one under `src/plugins/<name>/` and list it in `src/plugins/index.ts`.
 */
export interface Plugin {
  name: string;
  summary: string;
  commands: Command[];
  /** Entries this plugin adds to the `pf` menu and `pf list`. */
  entries?(ctx: Context): Entry[];
}
