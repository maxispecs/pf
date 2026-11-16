import type { Context } from '@pulpfixer/kit/context';
import { detectLocalCli, type LocalCli, type LocalCliCommand } from '@pulpfixer/kit/detect/localcli';
import { runCmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';

/** The repo's local developer CLI (`./a`), when it has one. */
export function localCliFor(ctx: Context): LocalCli | null {
  return ctx.repo ? detectLocalCli(ctx.repo.root) : null;
}

function printTools(cli: LocalCli): void {
  const c = out();
  const width = Math.max(...cli.commands.map((x) => x.name.length));
  process.stdout.write(`${c.bold(`Tools in this repo (${cli.entry})`)}\n`);
  for (const t of cli.commands) {
    process.stdout.write(`  ${termLine(`pf tools ${t.name}`, c)}${' '.repeat(Math.max(0, width - t.name.length))}  ${t.desc}\n`);
  }
  process.stdout.write(`\n${c.dim('Extra arguments go to the tool. See')} ${termLine(`${cli.entry} help <tool>`, c)}${c.dim('.')}\n`);
}

function run(ctx: Context, cli: LocalCli, tool: LocalCliCommand, args: string[], dryRun: boolean): Promise<number> {
  return runCmd({ argv: [cli.entry, tool.name, ...args], cwd: ctx.repo!.root }, { dryRun, base: ctx.workdir });
}

export const toolsCommand: Command = {
  name: 'tools',
  summary: "Run this repo's own tools (its ./a commands)",
  group: 'Tools',
  usage: 'pf tools [<tool> [args...]] [--dry-run]',
  async run(ctx, args) {
    const c = err();
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    if (!ctx.repo) {
      process.stderr.write(`${badgeLabel('error', c)} pf tools needs a repo. Run it inside a project directory.\n`);
      return 1;
    }
    const cli = localCliFor(ctx);
    if (!cli) {
      process.stderr.write(`${badgeLabel('error', c)} this repo has no local CLI (an ${c.bold('a')} script next to ${c.bold('cli/commands/')}).\n`);
      return 1;
    }
    const name = rest.shift();
    if (name) {
      const tool = cli.commands.find((t) => t.name === name);
      if (!tool) {
        process.stderr.write(`${badgeLabel('error', c)} unknown tool ${c.bold(name)}. Run ${termLine('pf tools', c)} to list them.\n`);
        return 2;
      }
      return run(ctx, cli, tool, rest, dryRun);
    }
    if (!interactive()) {
      printTools(cli);
      return 0;
    }
    const chosen = await pick(
      `Which tool? (${cli.entry})`,
      cli.commands.map((t) => ({ value: t, label: t.name, hint: t.desc })),
    );
    if (!chosen) return 0;
    process.stderr.write(`${c.dim('next time:')} ${termLine(`pf tools ${chosen.name}`, c)}\n`);
    return run(ctx, cli, chosen, [], dryRun);
  },
};
