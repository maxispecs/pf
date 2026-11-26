import fs from 'node:fs';
import path from 'node:path';
import { defaultMeta } from './actionmeta.js';
import { findCheckout, runDevCycle } from './devcycle.js';
import { resolveAgent } from './agent/agents.js';
import { aboutCommand } from './commands/about.js';
import { agentCommand } from './commands/agent.js';
import { runDeployAuto, runDeployStaging, runPublishStaging } from './commands/deploy.js';
import { runDoc } from './commands/doc.js';
import { gitCommand, readRepo } from './commands/git.js';
import { resolvePrimary } from './gitpush.js';
import { loadLocalConfig } from '@pulpfixer/kit/local-state';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { installCommand, runInstall } from './commands/install.js';
import { setupCommand } from './commands/setup.js';
import { skillCommand } from './commands/skill.js';
import { runTask, TASK_COMMANDS } from './commands/tasks.js';
import { localCliFor, toolsCommand } from './commands/tools.js';
import { troubleshootCommand } from './commands/troubleshoot.js';
import { GROUPS, type Entry } from '@pulpfixer/kit/types';
import { updateCommand } from './commands/update.js';
import { pluginCommand } from './commands/plugin.js';
import { profileCommand } from './commands/profile.js';
import { repoCommand } from './commands/repo.js';
import { newCommand } from './commands/new.js';
import { templateCommand } from './commands/template.js';
import { verCommand } from './commands/ver.js';
import { versionsCommand } from './commands/versions.js';
import type { Context } from '@pulpfixer/kit/context';
import { detectDocs } from '@pulpfixer/kit/detect/docs';
import { detectDeploy, detectProduction, detectStaging } from '@pulpfixer/kit/detect/deploy';
import { findInstallTargets, installTargetOf } from '@pulpfixer/kit/detect/install';
import { detectPublishStaging } from '@pulpfixer/kit/detect/publish';
import { candidates } from '@pulpfixer/kit/detect/resolve';
import type { Task } from '@pulpfixer/kit/detect/stacks';
import { formatCmd, runCmd, shellCmd, withArgs } from '@pulpfixer/kit/exec';
import { findVersionsRoot } from './commands/ver.js';
import { lastMenuChoice, loadRepoConfig, rememberMenuChoice } from '@pulpfixer/kit/config';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { h2, termLine } from '@pulpfixer/kit/ui/text';
import { pluginEntries } from './plugins/index.js';
import { interactive } from '@pulpfixer/kit/util';
import { resolveProfile } from '@pulpfixer/kit/profiles';

const BUILTIN_NAMES = new Set(['dev', 'build', 'test', 'lint', 'install', 'doc', 'docs', 'deploy:staging', 'deploy:production', 'deploy', 'publish:staging', 'publish:cellars']);

function agentEntry(ctx: Context): Entry {
  const choice = resolveAgent({ env: process.env.PF_AGENT, configured: ctx.user.agent });
  const ready = Boolean(choice.agent && !choice.missing && !choice.unknown);
  return {
    name: 'agent',
    summary: 'Open the coding agent',
    group: 'Agent',
    detail: ready ? `${choice.agent!.label}${choice.source === 'detected' ? ' (auto)' : ''}` : 'not set up',
    run: () => agentCommand.run(ctx, []),
  };
}

function profileDetail(ctx: Context): string {
  const p = resolveProfile(ctx);
  if (!p) return Object.keys(ctx.user.profiles ?? {}).length ? 'none here' : 'not set up';
  return p.config ? `${p.name} (${p.source})` : `${p.name} (not configured)`;
}

/** Run a custom command from pulpfixer.json. */
export function runCustom(ctx: Context, name: string, args: string[]): Promise<number> {
  const cfg = ctx.config.commands[name]!;
  const root = ctx.repo?.root ?? ctx.cwd;
  return runCmd(withArgs(shellCmd(cfg.run, path.resolve(root, cfg.cwd ?? '.')), args), { base: root });
}

/** The workbench tools shown first in its submenu; the others follow in file order. */
const WORKBENCH_ORDER = ['wb-new', 'wb-promote', 'ddb-check'];

/**
 * In the pulpfixer checkout's root: one `workbench` entry (Agent group, next to `agent` and
 * `troubleshoot`) that opens a submenu of the tools registered in `workbench/pulpfixer.json`.
 * They run from `workbench/` (the folder pf would read them from), so `cli` says how to run the
 * same thing from a shell. The tools ask for missing inputs themselves when there is a terminal.
 */
export function workbenchEntries(ctx: Context): Entry[] {
  if (!ctx.repo) return [];
  const checkout = findCheckout(ctx.repo.root);
  if (!checkout || checkout !== path.resolve(ctx.repo.root)) return [];
  const dir = path.join(checkout, 'workbench');
  if (!fs.existsSync(dir)) return [];
  const rank = (n: string) => {
    const i = WORKBENCH_ORDER.indexOf(n);
    return i === -1 ? WORKBENCH_ORDER.length : i;
  };
  const tools = Object.entries(loadRepoConfig(dir).commands)
    .map(([name, cfg], i) => ({ name, cfg, i }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i);
  if (!tools.length) return [];
  const sub: Entry[] = tools.map(({ name, cfg }) => ({
    name,
    summary: cfg.description ?? cfg.run,
    group: 'Workbench',
    cli: `(cd workbench && pf ${name})`,
    run: () => runCmd(shellCmd(cfg.run, path.resolve(dir, cfg.cwd ?? '.')), { base: dir }),
  }));
  return [
    {
      name: 'workbench',
      summary: 'Ad-hoc and repeatable tools (new, promote, ddb-check)',
      group: 'Agent',
      detail: `${sub.length} tool${sub.length === 1 ? '' : 's'}`,
      cli: '(cd workbench && pf)',
      run: () =>
        runMenu(ctx, {
          entries: sub,
          title: 'Workbench. What do you want to do?',
          heading: 'workbench',
          historyKey: `workbench:${checkout}`,
        }),
    },
  ];
}

function groupRank(g: string): number {
  const i = (GROUPS as readonly string[]).indexOf(g);
  return i === -1 ? GROUPS.indexOf('Tools') - 0.5 : i; // custom groups sit between Docs & deploy and Tools
}

/**
 * Everything the menu and the static list show for this context.
 * In a repo the entries adapted from it come first, as one block (run, build, deploy, the repo's own
 * commands and CLI: whatever was found); pf's own tools (agent, versions, plugins, ...) follow.
 */
export function entriesFor(ctx: Context): Entry[] {
  const entries: Entry[] = [];
  const fromRepo: Entry[] = [];
  /** Action metadata for an entry adapted from the repo: its id, the pf args that run it and the default icon / featured flag. */
  const action = (id: string, argv: string[], own: { icon?: string; featured?: boolean; when?: string[] } = {}) => {
    const d = defaultMeta(id);
    const when = own.when ?? d.when;
    return { id, argv, icon: own.icon ?? d.icon, featured: own.featured ?? d.featured, ...(when ? { when } : {}) };
  };
  const tool = (cmd: { name: string; summary: string; run: (c: Context, a: string[]) => Promise<number> }, group: string, detail?: string): Entry => ({
    name: cmd.name,
    summary: cmd.summary,
    group,
    ...(detail ? { detail } : {}),
    run: () => cmd.run(ctx, []),
  });

  if (ctx.repo) {
    entries.push(agentEntry(ctx));
    entries.push(tool(troubleshootCommand, 'Agent', profileDetail(ctx)));
    entries.push(...workbenchEntries(ctx));
    for (const t of TASK_COMMANDS) {
      const list = candidates(t.name as Task, ctx);
      if (list.length === 0) continue;
      fromRepo.push({
        name: t.name,
        summary: t.summary,
        group: t.group,
        ...action(t.name, [t.name]),
        detail: formatCmd(list[0]!.cmd, ctx.workdir) + (list.length > 1 ? `  (+${list.length - 1} more)` : ''),
        run: () => runTask(ctx, t.name as Task, { pick: true }),
      });
    }
    // Install: one entry per install target the repo defines, else the dependency install.
    const installs = findInstallTargets(ctx);
    if (installs.size) {
      for (const [target, cand] of installs) {
        fromRepo.push({
          name: `install ${target}`,
          summary: target === 'local' ? 'Install locally' : `Install to ${target}`,
          group: 'Develop',
          ...action(`install:${target}`, ['install', target]),
          detail: formatCmd(cand.cmd, ctx.workdir),
          run: () => runInstall(ctx, target),
        });
      }
    } else {
      const deps = candidates('install', ctx);
      if (deps.length) {
        fromRepo.push({
          name: 'install',
          summary: installCommand.summary,
          group: 'Develop',
          ...action('install', ['install']),
          detail: formatCmd(deps[0]!.cmd, ctx.workdir) + (deps.length > 1 ? `  (+${deps.length - 1} more)` : ''),
          run: () => runTask(ctx, 'install', { pick: true }),
        });
      }
    }
    const docs = detectDocs(ctx);
    if (docs.length) {
      fromRepo.push({
        name: 'doc',
        summary: 'Run the docs site locally',
        group: 'Docs & deploy',
        ...action('doc', ['doc']),
        detail: formatCmd(docs[0]!.cmd, ctx.workdir),
        run: () => runDoc(ctx, { pick: true }),
      });
    }
    const staging = detectStaging(ctx);
    if (staging.steps.length) {
      fromRepo.push({
        name: 'deploy staging',
        summary: 'Deploy to staging',
        group: 'Docs & deploy',
        ...action('deploy:staging', ['deploy', 'staging']),
        detail: `${staging.steps.length} step(s), asks first`,
        run: () => runDeployStaging(ctx),
      });
    } else {
      // No staging: offer the production or bare deploy the repo defines. It always asks first.
      const production = detectProduction(ctx);
      const bare = production.steps.length ? null : detectDeploy(ctx);
      const found = production.steps.length ? production : bare;
      if (found?.steps.length) {
        fromRepo.push({
          name: production.steps.length ? 'deploy production' : 'deploy',
          summary: production.steps.length ? 'Deploy to production' : 'Deploy (the repo\'s own deploy command)',
          group: 'Docs & deploy',
          ...(production.steps.length ? action('deploy:production', ['deploy', 'production']) : action('deploy', ['deploy'])),
          detail: formatCmd(found.steps[0]!.cmd, ctx.workdir) + ', asks first',
          run: () => runDeployAuto(ctx),
        });
      }
    }
    const publish = detectPublishStaging(ctx);
    if (publish.steps.length) {
      fromRepo.push({
        name: 'publish staging',
        summary: 'Publish to the staging registry (cellars)',
        group: 'Docs & deploy',
        ...action('publish:staging', ['publish', 'staging']),
        detail: formatCmd(publish.steps[0]!.cmd, ctx.workdir) + ', asks first',
        run: () => runPublishStaging(ctx),
      });
    }
    const push = ctx.repo.hasGit ? readRepo(ctx.repo.root) : null;
    if (push) {
      const cfg = loadLocalConfig(push.root).git?.push ?? {};
      const primary = resolvePrimary(cfg, push.upstreamRemote, push.remotes);
      const extra = (cfg.secondary ?? []).filter((r) => r !== primary).length;
      if (push.remotes.length) {
        fromRepo.push({
          name: 'git push',
          summary: 'Push to the primary remote and the backup remotes set up here',
          group: 'Develop',
          ...action('git:push', ['git', 'push']),
          detail: `${primary}${extra ? ` + ${extra} backup` : ''}`,
          run: () => gitCommand.run(ctx, ['push']),
        });
      }
      fromRepo.push({
        name: 'repo commit',
        summary: 'Commit everything with a message written from the last chat',
        group: 'Develop',
        ...action('repo:commit', ['repo', 'commit']),
        detail: 'pf g, asks first',
        run: () => repoCommand.run(ctx, ['commit']),
      });
      fromRepo.push({
        name: 'git',
        summary: gitCommand.summary,
        group: 'Develop',
        run: () => gitCommand.run(ctx, []),
      });
    }
    // The pulpfixer checkout's own dev cycle (`pf c`): bump, commit, publish to staging, update pf.
    const checkout = findCheckout(ctx.repo.root);
    if (checkout && checkout === path.resolve(ctx.repo.root)) {
      fromRepo.push({
        name: 'cycle',
        summary: 'Dev cycle (bump, commit, publish, update pf)',
        group: 'Develop',
        ...action('cycle', ['c']),
        detail: 'pf c, asks first',
        run: () => runDevCycle(checkout),
      });
    }
    for (const [name, cfg] of Object.entries(ctx.config.commands)) {
      if (BUILTIN_NAMES.has(name) || installTargetOf(name)) continue;
      fromRepo.push({
        name,
        summary: cfg.description ?? cfg.run,
        group: cfg.group ?? 'Tools',
        ...action(name, [name], { icon: cfg.icon, featured: cfg.featured, when: cfg.when }),
        ...(cfg.description ? { detail: cfg.run } : {}),
        run: () => runCustom(ctx, name, []),
      });
    }
    entries.push(tool(verCommand, 'Tools', findVersionsRoot(ctx.cwd) ? 'versions.json' : 'not set up yet'));
    const localCli = localCliFor(ctx);
    if (localCli) fromRepo.push({ ...tool(toolsCommand, 'Tools', `${localCli.commands.length} in ${localCli.entry}`), ...action('tools', ['tools']) });
    entries.push(tool(skillCommand, 'Tools'));
    entries.push(tool(newCommand, 'Tools'));
    entries.push(tool(pluginCommand, 'Tools'));
    entries.push(tool(versionsCommand, 'Tools'));
    entries.push(tool(repoCommand, 'Tools'));
    entries.push(tool(profileCommand, 'Tools', profileDetail(ctx)));
    if (!ctx.repo.hasConfig) entries.push(tool(initCommand, 'Tools'));
    entries.push(tool(doctorCommand, 'Tools'));
    entries.push(tool(updateCommand, 'Tools'));
    entries.push(tool(aboutCommand, 'Help'));
  } else {
    entries.push(agentEntry(ctx));
    entries.push({ ...tool(skillCommand, 'Tools'), name: 'skill', summary: 'Run a skill' });
    entries.push(tool(pluginCommand, 'Tools'));
    entries.push(tool(newCommand, 'Tools'));
    entries.push(tool(templateCommand, 'Tools'));
    entries.push(tool(versionsCommand, 'Tools'));
    entries.push(tool(profileCommand, 'Tools', profileDetail(ctx)));
    entries.push(tool(doctorCommand, 'Tools'));
    entries.push(tool(setupCommand, 'Tools'));
    entries.push(tool(updateCommand, 'Tools'));
    entries.push(tool(aboutCommand, 'Help'));
  }
  entries.push(...pluginEntries(ctx));
  const byGroup = (list: Entry[]) =>
    list
      .map((e, i) => ({ e, i }))
      .sort((a, b) => groupRank(a.e.group) - groupRank(b.e.group) || a.i - b.i)
      .map(({ e }) => e);
  // One group for the repo's own entries keeps them together above the rest, whatever groups they had.
  const repoGroup = ctx.repo?.name ?? '';
  return [...byGroup(fromRepo).map((e) => ({ ...e, group: repoGroup })), ...byGroup(entries)];
}

/** Static grouped list: `pf list`, and the fallback when there is no terminal. */
export function printList(ctx: Context, entries: Entry[] = entriesFor(ctx), heading?: string): void {
  const c = out();
  const key = (e: Entry) => e.cli ?? `pf ${e.name}`;
  const width = Math.max(...entries.map((e) => key(e).length));
  const sw = Math.max(...entries.map((e) => e.summary.length));
  const w = (s: string) => process.stdout.write(s + '\n');
  w(heading ? c.bold(heading) : ctx.repo ? `${c.bold(ctx.repo.name)}  ${c.dim(ctx.stacks.map((s) => s.label).join(', ') || 'no stack detected')}` : c.bold('Not inside a repo'));
  let group = '';
  for (const e of entries) {
    if (e.group !== group) {
      group = e.group;
      w(heading ? `\n${h2(group, c)}` : '');
    }
    w(`  ${termLine(key(e), c)}${' '.repeat(width - key(e).length)}  ${e.detail ? e.summary.padEnd(sw) + c.dim('  ' + e.detail) : e.summary}`);
  }
  w(`\n${termLine('pf help', c)} ${c.dim('shows every command and option,')} ${termLine('pf s', c)} ${c.dim('lists the shortcuts.')}`);
}

/** Interactive menu. Without a terminal it prints the static list instead. */
export async function runMenu(
  ctx: Context,
  custom: { entries: Entry[]; title: string; heading: string; historyKey: string } | null = null,
): Promise<number> {
  if (!interactive()) {
    if (custom) printList(ctx, custom.entries, custom.heading);
    else printList(ctx);
    return 0;
  }
  const entries = custom?.entries ?? entriesFor(ctx);
  const title = custom?.title ?? (ctx.repo ? `What do you want to do in ${ctx.repo.name}?` : 'Not inside a repo. What now?');
  const historyKey = custom?.historyKey ?? ctx.repo?.root ?? '(no repo)';
  const last = entries.find((e) => e.name === lastMenuChoice(historyKey));
  const chosen = await pick(
    title,
    entries.map((e) => ({
      value: e,
      label: e.name,
      hint: e.summary,
      group: e.group,
      ...(e.detail ? { detail: e.detail } : {}),
    })),
    // The main menu keeps its grouping but not the group names; custom menus (the ./pf launcher) keep them.
    {
      ...(last ? { initial: last } : {}),
      ...(custom ? {} : { groupNames: false }),
    },
  );
  if (!chosen) return 0;
  rememberMenuChoice(historyKey, chosen.name);
  process.stderr.write(`${err().dim('next time:')} ${termLine(chosen.cli ?? `pf ${chosen.name}`, err())}\n`);
  return chosen.run();
}
