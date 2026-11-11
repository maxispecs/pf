import type { Context } from '@pulpfixer/kit/context';
import { detectPublishStaging } from '@pulpfixer/kit/detect/publish';
import { formatCmd, runCmd } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { takeFlag } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';

/** Publish the repo's packages to the staging registry (cellars). Publishing cannot be undone, so it always confirms. */
export async function runPublishStaging(ctx: Context, opts: { dryRun?: boolean; yes?: boolean } = {}): Promise<number> {
  const c = err();
  if (!ctx.repo) {
    process.stderr.write(`${badgeLabel('error', c)} pf publish needs a repo. Run it inside a project directory.\n`);
    return 1;
  }
  const plan = detectPublishStaging(ctx);
  if (plan.steps.length === 0) {
    process.stderr.write(
      `${badgeLabel('error', c)} no publish target found.\n` +
        `Add a ${c.bold('publish:cellars')} script to package.json, or to ${c.bold('pulpfixer.json')}: { "commands": { "publish:staging": { "run": "<your command>" } } }\n`,
    );
    return 1;
  }

  process.stderr.write(`${c.bold('Staging publish')} ${c.dim('(cellars registry)')}\n`);
  plan.steps.forEach((s, i) => {
    process.stderr.write(`  ${c.dim(`${i + 1}.`)} ${termLine(formatCmd(s.cmd, ctx.repo!.root), c)}  ${c.dim(s.source)}\n`);
  });
  if (opts.dryRun) return 0;

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${badgeLabel('error', c)} refusing to publish without a terminal. Pass --yes to confirm, or --dry-run to preview.\n`);
      return 2;
    }
    if (!(await confirm('Publish to the staging registry now?', false, { flag: '--yes' }))) {
      process.stderr.write(c.dim('cancelled\n'));
      return 130;
    }
  }
  for (const s of plan.steps) {
    const code = await runCmd(s.cmd, { base: ctx.repo.root });
    if (code !== 0) return code;
  }
  return 0;
}

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
