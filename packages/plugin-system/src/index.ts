import type { Entry } from '@pulpfixer/kit/types';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { sysCommand } from './commands/sys.js';

export { BG_TONE_EXTENSION, SUITE_PRESET, bgToneStatus, installSuite, updateSuiteExtensions, type BgToneStatus } from './suite.js';

/**
 * `pf sys`: apply standard configuration presets to apps on this machine, starting with Cursor
 * (extensions and settings). The app adapters live here (`apps/`); the presets themselves are
 * separate data packages, `@pulpfixer/preset-<name>`, fetched at their latest version on every
 * apply, so they are published on their own and do not ship inside pf.
 */
export const systemPlugin: Plugin = {
  name: 'system',
  summary: 'Apply standard app configuration presets (pf sys)',
  commands: [sysCommand],
  entries(ctx): Entry[] {
    return [
      {
        name: 'sys',
        summary: 'Apply standard app configuration (Cursor)',
        group: 'Tools',
        detail: 'pf sys list, diff and apply',
        run: () => sysCommand.run(ctx, []),
      },
    ];
  },
};
