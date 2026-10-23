import type { Context } from '@pulpfixer/kit/context';
import { candidates } from '@pulpfixer/kit/detect/resolve';
import type { Candidate, Task } from '@pulpfixer/kit/detect/stacks';
import { formatCmd, runCmd, withArgs } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { pick } from '@pulpfixer/kit/ui/picker';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import type { Command, Group } from '@pulpfixer/kit/types';

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
    `Add one to ${c.bold('pf.json')} (run ${termLine('pf init', c)} to create it):`,
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
      return runTask(ctx, task, { dryRun, pick: pickFlag, extra: rest });
    },
  };
}

export const TASK_COMMANDS: Command[] = (['dev', 'build', 'test', 'lint', 'install'] as Task[]).map(taskCommand);
