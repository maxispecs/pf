import { detectDocs } from '@pulpfixer/kit/detect/docs';
import { formatCmd, runCmd, withArgs } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel } from '@pulpfixer/kit/ui/text';
import { pick } from '@pulpfixer/kit/ui/picker';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import type { Context } from '@pulpfixer/kit/context';
import type { Candidate } from '@pulpfixer/kit/detect/stacks';
import type { Command } from '@pulpfixer/kit/types';

export async function runDoc(ctx: Context, opts: { dryRun?: boolean; pick?: boolean; extra?: string[] } = {}): Promise<number> {
  const c = err();
  if (!ctx.repo) {
    process.stderr.write(`${badgeLabel('error', c)} pf doc needs a repo. Run it inside a project directory.\n`);
    return 1;
  }
  const list = detectDocs(ctx);
  if (list.length === 0) {
    process.stderr.write(
      `${badgeLabel('error', c)} no docs site found (looked for doc scripts, Nextra, Docusaurus, VitePress, Starlight, mkdocs, Sphinx, mdBook, Hugo).\n` +
        `Add one to ${c.bold('pf.json')}: { "commands": { "doc": { "run": "<your command>" } } }\n`,
    );
    return 1;
  }
  let chosen: Candidate | null = list[0]!;
  if (list.length > 1 && opts.pick && interactive()) {
    chosen = await pick('Which docs site?', list.map((x) => ({ value: x, label: formatCmd(x.cmd, ctx.workdir), hint: x.source })));
    if (!chosen) return 130;
  } else if (list.length > 1) {
    process.stderr.write(c.dim(`using ${chosen.source}; ${list.length - 1} other option(s), see pf doc --pick\n`));
  }
  return runCmd(withArgs(chosen.cmd, opts.extra ?? []), { dryRun: opts.dryRun, base: ctx.workdir });
}

export const docCommand: Command = {
  name: 'doc',
  summary: 'Run the docs site locally',
  group: 'Docs & deploy',
  usage: 'pf doc [--dry-run] [--pick]',
  async run(ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const pickFlag = takeFlag(rest, '--pick', '-p');
    if (rest[0] === '--') rest.shift();
    return runDoc(ctx, { dryRun, pick: pickFlag, extra: rest });
  },
};
