import type { Context } from '../context.js';
import { detectStaging } from '../detect/deploy.js';
import { formatCmd, runCmd } from '../exec.js';
import { err } from '../ui/palette.js';
import { confirm } from '../ui/prompt.js';
import { takeFlag } from '../util.js';
import type { Command } from './types.js';

export async function runDeployStaging(ctx: Context, opts: { dryRun?: boolean; yes?: boolean } = {}): Promise<number> {
  const c = err();
  if (!ctx.repo) {
    process.stderr.write(`${c.red('error:')} pf deploy needs a repo. Run it inside a project directory.\n`);
    return 1;
  }
  const plan = detectStaging(ctx);
  for (const s of plan.skipped) process.stderr.write(`${c.yellow('!')} skipped ${s}\n`);
  if (plan.steps.length === 0) {
    process.stderr.write(
      `${c.red('error:')} no staging target found.\n` +
        `Add one to ${c.bold('pf.json')}: { "commands": { "deploy:staging": { "run": "<your command>" } } }\n`,
    );
    return 1;
  }

  process.stderr.write(`${c.bold('Staging deploy')} ${c.dim('(production is never targeted)')}\n`);
  plan.steps.forEach((s, i) => {
    process.stderr.write(`  ${i + 1}. ${c.bold(formatCmd(s.cmd, ctx.repo!.root))}  ${c.dim(s.source)}\n`);
  });
  if (opts.dryRun) return 0;

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${c.red('error:')} refusing to deploy without a terminal. Pass --yes to confirm, or --dry-run to preview.\n`);
      return 2;
    }
    if (!(await confirm(`Run ${plan.steps.length} step(s) now?`, false))) {
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

export const deployCommand: Command = {
  name: 'deploy',
  summary: 'Deploy to staging (never production)',
  group: 'Docs & deploy',
  usage: 'pf deploy staging [--dry-run] [--yes]',
  async run(ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const yes = takeFlag(rest, '--yes', '-y');
    if (rest[0] !== 'staging') {
      process.stderr.write(`usage: ${deployCommand.usage}\nOnly staging is supported; production deploys are never run by pf.\n`);
      return 2;
    }
    return runDeployStaging(ctx, { dryRun, yes });
  },
};
