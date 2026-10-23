import type { Entry } from '../../commands/types.js';
import type { Plugin } from '../types.js';
import { dlCommand } from './commands/dl.js';
import { s3Command } from './commands/s3.js';
import { loadExchange } from './exchange.js';

/**
 * AWS shortcuts. First feature: a shared exchange bucket (`pf s3`, `pf dl`).
 * Add new AWS commands under `commands/` and list them here.
 */
export const awsPlugin: Plugin = {
  name: 'aws',
  summary: 'AWS CLI shortcuts',
  commands: [s3Command, dlCommand],
  entries(ctx): Entry[] {
    const cfg = loadExchange();
    return [
      {
        name: 'dl',
        summary: 'Download from the exchange bucket',
        group: 'AWS',
        detail: cfg.bucket ? `s3://${cfg.bucket}/${cfg.prefix} (profile ${cfg.profile})` : 'not set up: pf s3 --setup',
        run: () => dlCommand.run(ctx, []),
      },
    ];
  },
};
