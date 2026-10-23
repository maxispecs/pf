import type { Context } from '../context.js';
import { detectProduction, detectStaging } from '../detect/deploy.js';
import { formatCmd, runCmd } from '../exec.js';
import { err } from '../ui/palette.js';
import { badgeLabel, termLine } from '../ui/text.js';
import { confirm } from '../ui/prompt.js';
import { takeFlag } from '../util.js';
import type { Command } from './types.js';

export type DeployEnv = 'staging' | 'production';

export async function runDeploy(ctx: Context, env: DeployEnv, opts: { dryRun?: boolean; yes?: boolean } = {}): Promise<number> {
  const c = err();
  if (!ctx.repo) {
    process.stderr.write(`${badgeLabel('error', c)} pf deploy needs a repo. Run it inside a project directory.\n`);
    return 1;
  }
  const plan = env === 'production' ? detectProduction(ctx) : detectStaging(ctx);
  for (const s of plan.skipped) process.stderr.write(`${badgeLabel('warning', c)} skipped ${s}\n`);
  if (plan.steps.length === 0) {
    const hint = env === 'production' ? 'Production is only run from a script or pf.json entry you define.\n' : '';
    process.stderr.write(
      `${badgeLabel('error', c)} no ${env} target found.\n${hint}` +
        `Add one to ${c.bold('pf.json')}: { "commands": { "deploy:${env}": { "run": "<your command>" } } }\n`,
    );
    return 1;
  }

  const title = env === 'production' ? c.bold('PRODUCTION deploy') : `${c.bold('Staging deploy')} ${c.dim('(production is never targeted)')}`;
  process.stderr.write(`${title}\n`);
  plan.steps.forEach((s, i) => {
    process.stderr.write(`  ${c.dim(`${i + 1}.`)} ${termLine(formatCmd(s.cmd, ctx.repo!.root), c)}  ${c.dim(s.source)}\n`);
  });
  if (opts.dryRun) return 0;

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${badgeLabel('error', c)} refusing to deploy without a terminal. Pass --yes to confirm, or --dry-run to preview.\n`);
      return 2;
    }
    if (!(await confirm(`Run ${plan.steps.length} ${env} step(s) now?`, false, { flag: '--yes' }))) {
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

export const runDeployStaging = (ctx: Context, opts: { dryRun?: boolean; yes?: boolean } = {}) => runDeploy(ctx, 'staging', opts);

export const deployCommand: Command = {
  name: 'deploy',
  summary: 'Deploy to staging, or production when the repo defines it',
  group: 'Docs & deploy',
  usage: 'pf deploy <staging|production> [--dry-run] [--yes]',
  async run(ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const yes = takeFlag(rest, '--yes', '-y');
    if (rest[0] !== 'staging' && rest[0] !== 'production') {
      process.stderr.write(`${err().dim('usage:')} ${termLine(deployCommand.usage, err())}\n`);
      return 2;
    }
    return runDeploy(ctx, rest[0], { dryRun, yes });
  },
};
