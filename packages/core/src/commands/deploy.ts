import type { Context } from '@pulpfixer/kit/context';
import { detectDeploy, detectProduction, detectStaging, type StagingPlan } from '@pulpfixer/kit/detect/deploy';
import type { Candidate } from '@pulpfixer/kit/detect/stacks';
import { formatCmd, runCmd, withArgs } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { splitDashes, takeFlag, takeOption } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';

/**
 * `staging` and `production` are the named environments. `repo` is a bare `deploy` the repo defines
 * without naming an environment: pf treats it like production and always asks first.
 */
export type DeployEnv = 'staging' | 'production' | 'repo';

export interface DeployOptions {
  dryRun?: boolean;
  yes?: boolean;
  /** Commit message for a deploy command that commits (`pf.json` `"message": true`). */
  message?: string;
}

const PLANS: Record<DeployEnv, (ctx: Context) => StagingPlan> = {
  staging: detectStaging,
  production: detectProduction,
  repo: detectDeploy,
};

/** Add the commit message to the last step when that step takes one. Warns when it cannot. */
export function applyMessage(steps: Candidate[], message: string | undefined): { steps: Candidate[]; ignored: boolean } {
  if (!message || steps.length === 0) return { steps, ignored: false };
  const last = steps.length - 1;
  if (!steps[last]!.acceptsMessage) return { steps, ignored: true };
  return { steps: steps.map((s, i) => (i === last ? { ...s, cmd: withArgs(s.cmd, [message]) } : s)), ignored: false };
}

function noTarget(env: DeployEnv): string {
  const c = err();
  if (env === 'production') {
    return (
      `${badgeLabel('error', c)} no production target found.\nProduction is only run from a script or pf.json entry you define.\n` +
      `Add one to ${c.bold('pf.json')}: { "commands": { "deploy:production": { "run": "<your command>" } } }\n`
    );
  }
  if (env === 'repo') {
    return (
      `${badgeLabel('error', c)} no deploy command found.\n` +
      `Add one to ${c.bold('pf.json')}: { "commands": { "deploy": { "run": "<your command>" } } }, or let the agent read the repo's helper with ${termLine('pf rp --deploy', c)}.\n`
    );
  }
  return (
    `${badgeLabel('error', c)} no staging target found.\n` +
    `Add one to ${c.bold('pf.json')}: { "commands": { "deploy:staging": { "run": "<your command>" } } }\n`
  );
}

export async function runDeploy(ctx: Context, env: DeployEnv, opts: DeployOptions = {}, note?: string): Promise<number> {
  const c = err();
  if (!ctx.repo) {
    process.stderr.write(`${badgeLabel('error', c)} pf deploy needs a repo. Run it inside a project directory.\n`);
    return 1;
  }
  const plan = PLANS[env](ctx);
  for (const s of plan.skipped) process.stderr.write(`${badgeLabel('warning', c)} skipped ${s}\n`);
  if (plan.steps.length === 0) {
    process.stderr.write(noTarget(env));
    return 1;
  }

  const { steps, ignored } = applyMessage(plan.steps, opts.message);
  if (ignored) {
    process.stderr.write(
      `${badgeLabel('warning', c)} this target takes no message, ignored: ${opts.message}\n` +
        `${c.dim('A pf.json command that commits can take one with')} ${termLine('"message": true', c)}${c.dim('.')}\n`,
    );
  }

  const title =
    env === 'production'
      ? c.bold('PRODUCTION deploy')
      : env === 'repo'
        ? `${c.bold('Deploy')} ${c.dim('(the repo defines it without naming an environment, so pf asks first)')}`
        : `${c.bold('Staging deploy')} ${c.dim('(production is never targeted)')}`;
  process.stderr.write(`${title}${note ? ` ${c.dim(note)}` : ''}\n`);
  steps.forEach((s, i) => {
    process.stderr.write(`  ${c.dim(`${i + 1}.`)} ${termLine(formatCmd(s.cmd, ctx.repo!.root), c)}  ${c.dim(s.source)}\n`);
  });
  if (opts.dryRun) return 0;

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${badgeLabel('error', c)} refusing to deploy without a terminal. Pass --yes to confirm, or --dry-run to preview.\n`);
      return 2;
    }
    const label = env === 'repo' ? 'deploy' : env;
    if (!(await confirm(`Run ${steps.length} ${label} step(s) now?`, false, { flag: '--yes' }))) {
      process.stderr.write(c.dim('cancelled\n'));
      return 130;
    }
  }
  for (const s of steps) {
    const code = await runCmd(s.cmd, { base: ctx.repo.root });
    if (code !== 0) return code;
  }
  return 0;
}

export const runDeployStaging = (ctx: Context, opts: DeployOptions = {}) => runDeploy(ctx, 'staging', opts);

/**
 * `pf deploy` without an environment: staging when the repo has it, else production when that is the
 * only target, else the repo's bare `deploy`.
 */
export async function runDeployAuto(ctx: Context, opts: DeployOptions = {}): Promise<number> {
  const c = err();
  if (!ctx.repo) return runDeploy(ctx, 'staging', opts);
  const pick = (['staging', 'production', 'repo'] as const).find((env) => PLANS[env](ctx).steps.length > 0);
  if (!pick) {
    process.stderr.write(
      `${badgeLabel('error', c)} nothing to deploy: no staging, production or deploy command found.\n` +
        `Add ${c.bold('deploy:staging')}, ${c.bold('deploy:production')} or ${c.bold('deploy')} to ${c.bold('pf.json')}, or run ${termLine('pf rp --deploy', c)} to let the agent read the repo's helper.\n`,
    );
    return 1;
  }
  const note = pick === 'staging' ? '(staging is configured)' : pick === 'production' ? '(the only target is production)' : '';
  return runDeploy(ctx, pick, opts, note || undefined);
}

export interface DeployArgs {
  env?: 'staging' | 'production';
  options: DeployOptions;
  /** Set when an argument looks like a mistyped flag. */
  bad?: string;
}

/** `pf deploy [staging|production] [message...] [-m text] [--dry-run] [--yes]` */
export function parseDeployArgs(args: string[]): DeployArgs {
  const [before, after] = splitDashes([...args]);
  const dryRun = takeFlag(before, '--dry-run', '-n');
  const yes = takeFlag(before, '--yes', '-y');
  const explicit = takeOption(before, '--message') ?? takeOption(before, '-m');
  const bad = before.find((a) => a.startsWith('-'));
  const env = before[0] === 'staging' || before[0] === 'production' ? (before.shift() as 'staging' | 'production') : undefined;
  const words = [...before, ...after].join(' ').trim();
  const message = (explicit ?? words).trim();
  return {
    ...(env ? { env } : {}),
    options: { dryRun, yes, ...(message ? { message } : {}) },
    ...(bad ? { bad } : {}),
  };
}

export const deployCommand: Command = {
  name: 'deploy',
  summary: 'Deploy: staging if configured, else production, else the repo\'s own deploy',
  group: 'Docs & deploy',
  usage: 'pf deploy [staging|production] [message...] [-m <text>] [--dry-run] [--yes]',
  async run(ctx, args) {
    const parsed = parseDeployArgs(args);
    if (parsed.bad) {
      process.stderr.write(`${badgeLabel('error', err())} unknown option ${parsed.bad}\n${err().dim('usage:')} ${termLine(deployCommand.usage, err())}\n`);
      return 2;
    }
    return parsed.env ? runDeploy(ctx, parsed.env, parsed.options) : runDeployAuto(ctx, parsed.options);
  },
};
