import type { Entry } from '@pulpfixer/kit/types';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { suiteCommand } from './commands/suite.js';
import { sysCommand } from './commands/sys.js';

export { BG_TONE_EXTENSION, CURSOR_FEATURE, bgToneStatus, enableFeatures, featureStatuses, installSuite, updateSuiteExtensions, type BgToneStatus } from './suite.js';

export { systemVersions, type SystemVersions } from './versions.js';

/**
 * `pf sys`: apply standard configuration presets to apps on this machine, starting with Cursor
 * (extensions and settings). The app adapters live here (`apps/`); the presets themselves are
 * separate data packages, `@pulpfixer/preset-<name>`, fetched at their latest version on every
 * apply, so they are published on their own and do not ship inside pf.
 */
export const systemPlugin: Plugin = {
  name: 'system',
  summary: 'Apply standard app configuration presets (pf sys)',
  commands: [sysCommand, suiteCommand],
  entries(ctx): Entry[] {
    return [
      {
        name: 'sys',
        summary: 'Apply standard app configuration (Cursor)',
        group: 'Tools',
        detail: 'pf sys list, diff and apply',
        run: () => sysCommand.run(ctx, []),
      },
      {
        name: 'suite',
        summary: 'The pulpfixer suite: enable Cursor setup and optional Obsidian',
        group: 'Tools',
        detail: 'pf suite list and enable',
        run: () => suiteCommand.run(ctx, []),
      },
    ];
  },
};
