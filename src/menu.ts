import path from 'node:path';
import { aboutCommand } from './commands/about.js';
import { runDeployStaging } from './commands/deploy.js';
import { runDoc } from './commands/doc.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { setupCommand } from './commands/setup.js';
import { skillCommand } from './commands/skill.js';
import { runTask, TASK_COMMANDS } from './commands/tasks.js';
import { GROUPS, type Entry } from './commands/types.js';
import { updateCommand } from './commands/update.js';
import { verCommand } from './commands/ver.js';
import type { Context } from './context.js';
import { detectDocs } from './detect/docs.js';
import { detectStaging } from './detect/deploy.js';
import { candidates } from './detect/resolve.js';
import type { Task } from './detect/stacks.js';
import { formatCmd, runCmd, shellCmd, withArgs } from './exec.js';
import { findVersionsRoot } from './commands/ver.js';
import { out } from './ui/palette.js';
import { pick } from './ui/picker.js';
import { interactive } from './util.js';

const BUILTIN_NAMES = new Set(['dev', 'build', 'test', 'lint', 'install', 'doc', 'docs', 'deploy:staging']);

/** Run a custom command from pf.json. */
export function runCustom(ctx: Context, name: string, args: string[]): Promise<number> {
  const cfg = ctx.config.commands[name]!;
  const root = ctx.repo?.root ?? ctx.cwd;
  return runCmd(withArgs(shellCmd(cfg.run, path.resolve(root, cfg.cwd ?? '.')), args), { base: root });
}

function groupRank(g: string): number {
  const i = (GROUPS as readonly string[]).indexOf(g);
  return i === -1 ? 2.5 : i; // custom groups sit between Docs & deploy and Tools
}

/** Everything the menu and the static list show for this context. */
export function entriesFor(ctx: Context): Entry[] {
  const entries: Entry[] = [];
  const tool = (cmd: { name: string; summary: string; run: (c: Context, a: string[]) => Promise<number> }, group: string, detail?: string): Entry => ({
    name: cmd.name,
    summary: cmd.summary,
    group,
    ...(detail ? { detail } : {}),
    run: () => cmd.run(ctx, []),
  });

  if (ctx.repo) {
    for (const t of TASK_COMMANDS) {
      const list = candidates(t.name as Task, ctx);
      if (list.length === 0) continue;
      entries.push({
        name: t.name,
        summary: t.summary,
        group: t.group,
        detail: formatCmd(list[0]!.cmd, ctx.workdir) + (list.length > 1 ? `  (+${list.length - 1} more)` : ''),
        run: () => runTask(ctx, t.name as Task, { pick: true }),
      });
    }
    const docs = detectDocs(ctx);
    if (docs.length) {
      entries.push({
        name: 'doc',
        summary: 'Run the docs site locally',
        group: 'Docs & deploy',
        detail: formatCmd(docs[0]!.cmd, ctx.workdir),
        run: () => runDoc(ctx, { pick: true }),
      });
    }
    const staging = detectStaging(ctx);
    if (staging.steps.length) {
      entries.push({
        name: 'deploy staging',
        summary: 'Deploy to staging',
        group: 'Docs & deploy',
        detail: `${staging.steps.length} step(s), asks first`,
        run: () => runDeployStaging(ctx),
      });
    }
    for (const [name, cfg] of Object.entries(ctx.config.commands)) {
      if (BUILTIN_NAMES.has(name)) continue;
      entries.push({
        name,
        summary: cfg.description ?? cfg.run,
        group: cfg.group ?? 'Tools',
        ...(cfg.description ? { detail: cfg.run } : {}),
        run: () => runCustom(ctx, name, []),
      });
    }
    entries.push(tool(verCommand, 'Tools', findVersionsRoot(ctx.cwd) ? 'versions.json' : 'not set up yet'));
    entries.push(tool(skillCommand, 'Tools'));
    if (!ctx.repo.hasConfig) entries.push(tool(initCommand, 'Tools'));
    entries.push(tool(doctorCommand, 'Tools'));
    entries.push(tool(updateCommand, 'Tools'));
    entries.push(tool(aboutCommand, 'Help'));
  } else {
    entries.push({ ...tool(skillCommand, 'Tools'), name: 'skill', summary: 'Run a skill' });
    entries.push(tool(doctorCommand, 'Tools'));
    entries.push(tool(setupCommand, 'Tools'));
    entries.push(tool(updateCommand, 'Tools'));
    entries.push(tool(aboutCommand, 'Help'));
  }
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => groupRank(a.e.group) - groupRank(b.e.group) || a.i - b.i)
    .map(({ e }) => e);
}

/** Static grouped list: `pf list`, and the fallback when there is no terminal. */
export function printList(ctx: Context): void {
  const c = out();
  const entries = entriesFor(ctx);
  const width = Math.max(...entries.map((e) => e.name.length));
  const sw = Math.max(...entries.map((e) => e.summary.length));
  const w = (s: string) => process.stdout.write(s + '\n');
  w(ctx.repo ? `${c.bold(ctx.repo.name)}  ${c.dim(ctx.stacks.map((s) => s.label).join(', ') || 'no stack detected')}` : c.bold('Not inside a repo'));
  let group = '';
  for (const e of entries) {
    if (e.group !== group) {
      group = e.group;
      w(`\n${c.dim(c.bold(group))}`);
    }
    w(`  ${c.boldBrand('pf ' + e.name.padEnd(width))}  ${e.detail ? e.summary.padEnd(sw) + c.dim('  ' + e.detail) : e.summary}`);
  }
  w(`\n${c.dim('pf help shows every command and option.')}`);
}

/** Interactive menu. Without a terminal it prints the static list instead. */
export async function runMenu(ctx: Context): Promise<number> {
  if (!interactive()) {
    printList(ctx);
    return 0;
  }
  const entries = entriesFor(ctx);
  const title = ctx.repo ? `What do you want to do in ${ctx.repo.name}?` : 'Not inside a repo. What now?';
  const chosen = await pick(
    title,
    entries.map((e) => ({ value: e, label: e.name, hint: e.detail ?? e.summary, group: e.group })),
  );
  if (!chosen) return 0;
  return chosen.run();
}
