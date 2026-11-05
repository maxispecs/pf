import type { Entry } from '@pulpfixer/kit/types';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { AWS_AGENT_TOOLS } from './agent-tools.js';
import { awsCommand } from './commands/aws.js';
import { dlCommand } from './commands/dl.js';
import { s3Command } from './commands/s3.js';
import { loadExchange } from './exchange.js';

export { DEFAULT_MAX_TTL, DEFAULT_SCOPES, HARD_MAX_TTL, SCOPE_NAMES, SCOPES } from './access.js';
export { whoami } from './agent-tools.js';
export { describeLimits, projectAws } from './project.js';

/**
 * AWS shortcuts: a shared exchange bucket (`pf s3`, `pf dl`), and scoped read-only AWS access
 * for the agent (`pf_aws_*` tools, `pf aws grants`). Add new AWS commands under `commands/` and list them here.
 */
export const awsPlugin: Plugin = {
  name: 'aws',
  summary: 'AWS CLI shortcuts and scoped AWS access for the agent',
  commands: [s3Command, dlCommand, awsCommand],
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
  tools: () => AWS_AGENT_TOOLS,
};
