import type { Entry } from '@pulpfixer/kit/types';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { AWS_AGENT_TOOLS } from './agent-tools.js';
import { awsCommand } from './commands/aws.js';
import { eventbridgeAdapter } from './adapter.js';
import { dlCommand } from './commands/dl.js';
import { eventsCommand } from './commands/events.js';
import { s3Command } from './commands/s3.js';
import { loadExchange } from './exchange.js';

export { DEFAULT_MAX_TTL, DEFAULT_SCOPES, HARD_MAX_TTL, SCOPE_NAMES, SCOPES } from './access.js';
export { whoami } from './agent-tools.js';
export { eventbridgeAdapter, eventbridgeSink, type EventBridgeSinkConfig } from './adapter.js';
export { buildEntries, buildEntry, chunkEntries, EventsError, parsePutResult, putEventsArgv, sendEntries, type EventInput, type PutEntry } from './events.js';
export { describeLimits, projectAws } from './project.js';
export { ACTIONS, ACTION_NAMES } from './access.js';
export { candidateDetail, candidateLabel, applyLink, linkChoices, type LinkChoices, type LinkExtra, type LinkResult } from './link.js';
export { awsConfigPath, listAwsProfiles, matchProfiles, parseAwsConfig, suggestProfileName, type AwsProfileInfo, type LinkCandidate } from './awsconfig.js';
export { describeDeployment, detectAwsDeployment, scanAwsHints, scopesFor, type AwsDeployment, type AwsHints } from './infra.js';

/**
 * AWS shortcuts: a shared exchange bucket (`pf s3`, `pf dl`), and scoped read-only AWS access
 * for the agent (`pf_aws_*` tools, `pf aws grants`), and EventBridge events (`pf events put`, the `eventbridge`
 * IO adapter sink for pipes). Events have no agent tools: they write, and their details can hold user data.
 * Add new AWS commands under `commands/` and list them here.
 */
export const awsPlugin: Plugin = {
  name: 'aws',
  api: 3,
  summary: 'AWS CLI shortcuts, EventBridge events and scoped AWS access for the agent',
  commands: [s3Command, dlCommand, awsCommand, eventsCommand],
  ioAdapters: [eventbridgeAdapter],
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
      {
        name: 'events',
        summary: 'Send an event to Amazon EventBridge',
        group: 'AWS',
        detail: 'pf events put --source <s> --type <t> [--detail <json>]',
        run: () => eventsCommand.run(ctx, []),
      },
    ];
  },
  tools: () => AWS_AGENT_TOOLS,
};
