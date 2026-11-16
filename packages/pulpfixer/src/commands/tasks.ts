import { buildContext, type Context } from '@pulpfixer/kit/context';
import { candidates } from '@pulpfixer/kit/detect/resolve';
import type { Candidate, Task } from '@pulpfixer/kit/detect/stacks';
import { formatCmd, runCmd, withArgs } from '@pulpfixer/kit/exec';
import { repoLink } from '@pulpfixer/kit/repo-link';
import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { pick } from '@pulpfixer/kit/ui/picker';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import type { Command, Group } from '@pulpfixer/kit/types';
import { isRepoSetUp, repoCommand } from './repo.js';

const SUMMARIES: Record<Task, string> = {
  dev: 'Run the app locally',
  build: 'Build the project',
  test: 'Run the tests',
  lint: 'Lint the code',
  install: 'Install dependencies',
};

const GROUP: Record<Task, Group> = {
  dev: 'Develop',
  install: 'Develop',
  build: 'Build & check',
  test: 'Build & check',
  lint: 'Build & check',
};

export function noCommandHint(task: string): string {
  const c = err();
  return [
    `${badgeLabel('error', c)} no ${task} command found for this repo.`,
    `Add one to ${c.bold('pulpfixer.json')} (run ${termLine('pf init', c)} to create it):`,
    `  { "commands": { "${task}": { "run": "<your command>" } } }`,
  ].join('\n');
}

export interface TaskRunOptions {
  dryRun?: boolean;
  pick?: boolean;
  extra?: string[];
}

/** Resolve and run one of the unified tasks. */
export async function runTask(ctx: Context, task: Task, opts: TaskRunOptions = {}): Promise<number> {
  const c = err();
  if (!ctx.repo) {
    process.stderr.write(`${badgeLabel('error', c)} pf ${task} needs a repo. Run it inside a project directory.\n`);
    return 1;
  }
  const list = candidates(task, ctx);
  if (list.length === 0) {
    process.stderr.write(noCommandHint(task) + '\n');
    return 1;
  }
  let chosen: Candidate | null = list[0]!;
  if (list.length > 1 && opts.pick && interactive()) {
    chosen = await pick(
      `Which ${task} command?`,
      list.map((cand) => ({ value: cand, label: formatCmd(cand.cmd, ctx.workdir), hint: cand.source })),
    );
    if (!chosen) return 130;
  } else if (list.length > 1) {
    process.stderr.write(c.dim(`using ${chosen.source}; ${list.length - 1} other option(s), see pf ${task} --pick\n`));
  }
  return runCmd(withArgs(chosen.cmd, opts.extra ?? []), { dryRun: opts.dryRun, base: ctx.workdir });
}

/**
 * `pf dev` in a repo `pf repo` has not been run in: offer to run it first, then offer to start dev.
 * In a set-up repo whose pf link is missing or stale, only print a hint to rerun `pf rp`.
 * Returns the exit code when the run is over (the user cancelled or `pf repo` failed), else null to carry on
 * with the task. Quiet without a terminal, with `--dry-run` or `PF_NO_REPO_PROMPT=1`.
 */
export async function offerRepoSetup(ctx: Context, task: Task, opts: { dryRun?: boolean } = {}): Promise<{ ctx: Context; code: number | null }> {
  const same = { ctx, code: null };
  if (task !== 'dev' || opts.dryRun || !ctx.repo || process.env.PF_NO_REPO_PROMPT === '1' || !interactive()) return same;
  const c = err();
  if (isRepoSetUp(ctx.repo.root)) {
    const link = repoLink(ctx.repo.root, ctx.config, { name: ctx.repo.name });
    if (link.state !== 'linked') process.stderr.write(c.dim(`pf link ${link.state}: ${link.reasons.join('; ')}. Run pf rp to refresh it.\n`));
    return same;
  }
  if (!(await confirm(`This repo is not set up with pf yet. Run ${c.bold('pf repo')} (pnpm commands, versioning, deploy) first?`, true))) return same;
  const code = await repoCommand.run(ctx, []);
  if (code !== 0) return { ctx, code };
  if (!(await confirm(`Start ${c.bold('pf dev')} now?`, true))) return { ctx, code: 0 };
  return { ctx: buildContext(ctx.cwd), code: null };
}

export function taskCommand(task: Task): Command {
  return {
    name: task,
    summary: SUMMARIES[task],
    group: GROUP[task],
    usage: `pf ${task} [--dry-run] [--pick]`,
    async run(ctx, args) {
      const rest = [...args];
      const dryRun = takeFlag(rest, '--dry-run', '-n');
      const pickFlag = takeFlag(rest, '--pick', '-p');
      if (rest[0] === '--') rest.shift();
      const offer = await offerRepoSetup(ctx, task, { dryRun });
      if (offer.code !== null) return offer.code;
      return runTask(offer.ctx, task, { dryRun, pick: pickFlag, extra: rest });
    },
  };
}

/** `pf install` is not here: it runs the repo's install targets first (`commands/install.ts`). */
export const TASK_COMMANDS: Command[] = (['dev', 'build', 'test', 'lint'] as Task[]).map(taskCommand);
