import { err } from '@pulpfixer/kit/ui/palette';
import { termLine } from '@pulpfixer/kit/ui/text';
import { takeFlag } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';
import { runPublishStaging } from './deploy.js';

/**
 * Publishing cannot be undone, so it always confirms. A repo with no publish target but a staging
 * deploy runs that instead, and `pf deploy` publishes in a repo that only publishes.
 */
export const publishCommand: Command = {
  name: 'publish',
  summary: 'Publish to the staging registry (cellars), via the repo\'s publish:cellars script',
  group: 'Docs & deploy',
  usage: 'pf publish staging [--dry-run] [--yes]',
  async run(ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const yes = takeFlag(rest, '--yes', '-y');
    if (rest[0] !== 'staging') {
      process.stderr.write(`${err().dim('usage:')} ${termLine(publishCommand.usage, err())}\n`);
      return 2;
    }
    return runPublishStaging(ctx, { dryRun, yes });
  },
};
