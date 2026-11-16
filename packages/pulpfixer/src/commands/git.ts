import type { Context } from '@pulpfixer/kit/context';
import { capture, runCmd } from '@pulpfixer/kit/exec';
import { loadLocalConfig, REMOTE_NAME, setLocalConfigSection, type GitPushConfig } from '@pulpfixer/kit/local-state';
import { normalizeRemote } from '@pulpfixer/kit/repo-link';
import type { Command } from '@pulpfixer/kit/types';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { ask } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, h2, termLine, ul } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import { planPush, resolvePrimary } from '../gitpush.js';

/**
 * `pf git`: git helpers for the repo.
 *
 *   pf git                      menu (status without a terminal)
 *   pf git push                 push to the primary remote, then to every backup remote (shortcut: `pf gp`)
 *   pf git status               the primary and backup remotes
 *   pf git backup [add|remove]  manage backup remotes
 *   pf git primary <remote>     which remote is pushed to first
 *
 * Backup remotes ("secondary" in `.pf/config.json`, machine-local and gitignored) get the same push as the primary.
 * With nothing configured `pf git push` is a plain `git push` to the primary remote.
 */

const git = (root: string, ...args: string[]) => capture(['git', ...args], { cwd: root });

interface Repo {
  root: string;
  branch: string | null;
  remotes: string[];
  upstreamRemote: string | undefined;
}

/** The git facts a push needs, or null outside a git work tree. */
export function readRepo(root: string): Repo | null {
  if (!git(root, 'rev-parse', '--is-inside-work-tree').ok) return null;
  const head = git(root, 'symbolic-ref', '--short', '-q', 'HEAD');
  const branch = head.ok && head.stdout.trim() ? head.stdout.trim() : null;
  const up = branch ? git(root, 'config', '--get', `branch.${branch}.remote`) : null;
  const upstream = up?.ok ? up.stdout.trim() : '';
  return {
    root,
    branch,
    remotes: git(root, 'remote').stdout.split('\n').map((l) => l.trim()).filter(Boolean),
    upstreamRemote: upstream || undefined,
  };
}

const display = (root: string, remote: string): string => {
  const r = git(root, 'remote', 'get-url', remote);
  return (r.ok && normalizeRemote(r.stdout)) || '';
};

const fail = (msg: string): number => {
  process.stderr.write(`${badgeLabel('error', err())} ${msg}\n`);
  return 1;
};

/** The repo for a subcommand, or null after saying why there is none. */
function needRepo(ctx: Context): Repo | null {
  const repo = ctx.repo ? readRepo(ctx.repo.root) : null;
  if (!repo) fail('pf git needs a git repository. Run it inside one.');
  return repo;
}

const secondaryOf = (config: GitPushConfig): string[] => config.secondary ?? [];

async function push(ctx: Context, args: string[]): Promise<number> {
  const c = err();
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const noSecondary = takeFlag(rest, '--no-secondary');
  const repo = needRepo(ctx);
  if (!repo) return 1;
  const config = loadLocalConfig(repo.root).git?.push ?? {};

  const plan = planPush({ config, branch: repo.branch, upstreamRemote: repo.upstreamRemote, remotes: repo.remotes, args: rest, secondary: !noSecondary });
  if (!plan.ok) return fail(plan.error);
  const names = plan.steps.map((s) => s.remote);
  process.stderr.write(`${c.dim(dryRun ? 'would push' : 'pushing')} ${c.bold(repo.branch ?? 'HEAD')} ${c.dim('to')} ${names.join(c.dim(', then '))}\n`);

  const failed: string[] = [];
  const results: string[] = [];
  for (const step of plan.steps) {
    const code = await runCmd({ argv: ['git', ...step.argv], cwd: repo.root }, { dryRun, base: repo.root });
    if (code === 0) {
      results.push(`${step.remote}: ${dryRun ? 'would push' : 'pushed'}`);
      continue;
    }
    results.push(`${step.remote}: failed (exit ${code})`);
    if (step.role === 'primary') {
      // A broken primary push never fans out to the backup remotes.
      fail(`push to ${step.remote} failed${plan.steps.length > 1 ? `, so the backup remotes were not pushed` : ''}`);
      return code;
    }
    failed.push(step.remote);
  }
  if (plan.steps.length > 1 && !dryRun) process.stderr.write(`\n${h2('Result', c)}\n${ul(results, c)}\n`);
  if (failed.length) return fail(`push failed for ${failed.join(', ')}; the others were pushed`);
  return 0;
}

const USAGE = [
  'pf git [push | status | backup | primary]',
  'pf git push [--dry-run] [--no-secondary] [git push args]',
  'pf git backup [add [<remote>] [<url>] | remove [<remote>]] [--dry-run]',
  'pf git primary [<remote> | --unset] [--dry-run]',
];

function printUsage(): void {
  const c = err();
  process.stderr.write(`${c.dim('usage:')}\n${USAGE.map((u) => `  ${termLine(u, c)}`).join('\n')}\n`);
}

function status(repo: Repo, config: GitPushConfig): void {
  const c = err();
  const primary = resolvePrimary(config, repo.upstreamRemote);
  const source = config.primary ? 'set in .pf/config.json' : repo.upstreamRemote ? 'the branch upstream' : 'the default';
  const line = (r: string, extra = '') => `${c.bold(r)}${display(repo.root, r) ? c.dim(`  ${display(repo.root, r)}`) : ''}${extra}${repo.remotes.includes(r) ? '' : c.dim('  (not a git remote here)')}`;
  const rows = [`${c.dim('primary:')}   ${line(primary, c.dim(`  (${source})`))}`];
  const secondary = secondaryOf(config).filter((r) => r !== primary);
  if (secondary.length) for (const r of secondary) rows.push(`${c.dim('backup:')}    ${line(r)}`);
  else rows.push(`${c.dim('backup:')}    ${c.dim('none, pf gp pushes the primary only')}`);
  process.stdout.write(`${rows.join('\n')}\n`);
  process.stderr.write(`${c.dim('Kept in .pf/config.json (this machine only, not committed). Add a backup remote with')} ${termLine('pf git backup', c)}\n`);
}

function save(repo: Repo, next: GitPushConfig, dryRun: boolean): number {
  const w = setLocalConfigSection(repo.root, 'git', { push: Object.keys(next).length ? next : undefined }, { dryRun });
  return w.ok ? 0 : fail(w.error);
}

const done = (msg: string, dryRun: boolean): number => {
  process.stderr.write(`${dryRun ? err().dim('would: ') : ''}${msg}\n`);
  return 0;
};

/** Tell the user how to repeat a menu or wizard step without it. */
const sameWithout = (cmd: string): void => {
  const c = err();
  process.stderr.write(`${c.dim('same without the menu:')} ${termLine(cmd, c)}\n`);
};

const invalidName = (name: string | undefined): string | null =>
  !name || !REMOTE_NAME.test(name) ? `"${name ?? ''}" is not a usable remote name (letters, digits, ".", "_" and "-")` : null;

/** Make `name` a backup remote: add the git remote first when `url` is given. */
function addBackup(repo: Repo, current: GitPushConfig, name: string, url: string | undefined, dryRun: boolean): number {
  const c = err();
  const primary = resolvePrimary(current, repo.upstreamRemote);
  const bad = invalidName(name);
  if (bad) return fail(`${bad}. Usage: ${USAGE[2]}`);
  if (name === primary) return fail(`"${name}" is the primary remote already`);
  if (secondaryOf(current).includes(name)) return done(`${name} is already a backup remote`, dryRun);
  if (!repo.remotes.includes(name)) {
    if (!url) return fail(`this repo has no git remote "${name}". Give its URL: pf git backup add ${name} <url>`);
    if (url.startsWith('-')) return fail(`"${url}" is not a usable remote URL`);
    if (!dryRun) {
      const r = git(repo.root, 'remote', 'add', name, url);
      if (!r.ok) return fail(`git remote add failed: ${r.stderr.trim()}`);
    }
    const shown = normalizeRemote(url) ?? 'the given URL';
    process.stderr.write(`${dryRun ? c.dim('would add') : 'added'} git remote ${c.bold(name)} ${c.dim(shown)}\n`);
  } else if (url) {
    return fail(`this repo already has a git remote "${name}", so the URL was not used. Drop it, or change the remote with git remote set-url`);
  }
  const secondary = [...secondaryOf(current), name];
  const code = save(repo, { ...current, secondary }, dryRun);
  return code === 0 ? done(`backup remote ${c.bold(name)} added: pf gp now pushes to ${primary}, then ${secondary.join(', ')}`, dryRun) : code;
}

/** The interactive "add a backup remote": pick an existing remote or name a new one and give its URL. */
async function backupWizard(repo: Repo, current: GitPushConfig, dryRun: boolean): Promise<number> {
  const primary = resolvePrimary(current, repo.upstreamRemote);
  const taken = new Set([primary, ...secondaryOf(current)]);
  const free = repo.remotes.filter((r) => !taken.has(r));
  let name: string | null = '';
  if (free.length) {
    name = await pick<string>('Backup remote', [
      ...free.map((r) => ({ value: r, label: r, hint: display(repo.root, r) })),
      { value: '', label: 'a new remote', hint: 'name it and give its URL' },
    ], { search: false });
    if (name === null) return 130;
  }
  if (name) {
    sameWithout(`pf git backup add ${name}`);
    return addBackup(repo, current, name, undefined, dryRun);
  }
  const base = 'backup';
  const initial = repo.remotes.includes(base) ? ([2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}${n}`).find((n) => !repo.remotes.includes(n)) ?? '') : base;
  name = await ask('Name of the new git remote', {
    initial,
    validate: (v) => invalidName(v.trim()) ?? (repo.remotes.includes(v.trim()) ? `this repo has a git remote "${v.trim()}" already` : null),
  });
  if (!name) return 130;
  const url = await ask(`URL of ${name}`, {
    placeholder: 'git@host:team/repo.git',
    validate: (v) => (!v.trim() ? 'a URL is needed' : v.trim().startsWith('-') ? 'not a usable remote URL' : null),
  });
  if (!url) return 130;
  sameWithout(`pf git backup add ${name} ${url}`);
  return addBackup(repo, current, name, url, dryRun);
}

async function backup(ctx: Context, args: string[]): Promise<number> {
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const repo = needRepo(ctx);
  if (!repo) return 1;
  const current = loadLocalConfig(repo.root).git?.push ?? {};
  const [action, name, url] = rest;

  if (!action || (action === 'add' && !name)) {
    if (!interactive()) {
      process.stderr.write(`${badgeLabel('error', err())} adding a backup remote needs a terminal, or give it: ${termLine('pf git backup add <remote> [<url>]', err())}\n`);
      return 2;
    }
    return backupWizard(repo, current, dryRun);
  }

  if (action === 'add') return addBackup(repo, current, name!, url, dryRun);

  if (action === 'remove') {
    const have = secondaryOf(current);
    let target = name;
    if (!target && interactive() && have.length) {
      const chosen = await pick<string>('Stop pushing to', have.map((r) => ({ value: r, label: r, hint: display(repo.root, r) })), { search: false });
      if (!chosen) return 130;
      target = chosen;
      sameWithout(`pf git backup remove ${target}`);
    }
    const bad = invalidName(target);
    if (bad) return fail(`${bad}. Usage: ${USAGE[2]}`);
    if (!have.includes(target!)) return fail(`"${target}" is not a backup remote (see pf git status)`);
    const secondary = have.filter((r) => r !== target);
    const { secondary: _drop, ...keep } = current;
    const code = save(repo, secondary.length ? { ...keep, secondary } : keep, dryRun);
    return code === 0 ? done(`backup remote ${err().bold(target!)} removed (the git remote itself is untouched)`, dryRun) : code;
  }

  printUsage();
  return 2;
}

async function primary(ctx: Context, args: string[]): Promise<number> {
  const c = err();
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const unset = takeFlag(rest, '--unset');
  const repo = needRepo(ctx);
  if (!repo) return 1;
  const current = loadLocalConfig(repo.root).git?.push ?? {};

  if (unset) {
    const { primary: _drop, ...keep } = current;
    const code = save(repo, keep, dryRun);
    return code === 0 ? done('primary remote unset: pf gp uses the branch upstream, else origin', dryRun) : code;
  }
  let name = rest[0];
  if (!name) {
    const now = resolvePrimary(current, repo.upstreamRemote);
    if (!interactive() || repo.remotes.length === 0) return fail(`name the remote: ${USAGE[3]} (this repo has: ${repo.remotes.join(', ') || 'no remotes'})`);
    const chosen = await pick<string>('Push to first', repo.remotes.map((r) => ({ value: r, label: r, hint: r === now ? `${display(repo.root, r)}  (now)`.trim() : display(repo.root, r) })), {
      search: false,
      initial: repo.remotes.includes(now) ? now : repo.remotes[0]!,
    });
    if (!chosen) return 130;
    name = chosen;
    sameWithout(`pf git primary ${name}`);
  }
  const bad = invalidName(name);
  if (bad) return fail(`${bad}. Usage: ${USAGE[3]}`);
  if (!repo.remotes.includes(name)) return fail(`this repo has no git remote "${name}" (it has: ${repo.remotes.join(', ') || 'none'})`);
  const secondary = secondaryOf(current).filter((r) => r !== name);
  const next: GitPushConfig = { primary: name, ...(secondary.length ? { secondary } : {}) };
  const code = save(repo, next, dryRun);
  return code === 0 ? done(`primary remote is now ${c.bold(name)}`, dryRun) : code;
}

type MenuAction = 'push' | 'status' | 'backup-add' | 'backup-remove' | 'primary';

/** The `pf git` menu: what to do with this repo's git. */
async function menu(ctx: Context): Promise<number> {
  const repo = needRepo(ctx);
  if (!repo) return 1;
  const config = loadLocalConfig(repo.root).git?.push ?? {};
  const items: { value: MenuAction; label: string; hint: string }[] = [
    { value: 'push', label: 'Push', hint: `to ${[resolvePrimary(config, repo.upstreamRemote), ...secondaryOf(config)].join(', then ')}` },
    { value: 'status', label: 'Remotes', hint: 'the primary and backup remotes' },
    { value: 'backup-add', label: 'Add a backup remote', hint: 'pf gp pushes there too' },
  ];
  if (secondaryOf(config).length) items.push({ value: 'backup-remove', label: 'Remove a backup remote', hint: 'stop pushing there' });
  if (repo.remotes.length > 1) items.push({ value: 'primary', label: 'Set the primary remote', hint: 'the one pushed to first' });
  const chosen = await pick<MenuAction>('Git', items, { search: false });
  if (!chosen) return 130;
  if (chosen === 'push') {
    sameWithout('pf gp');
    return push(ctx, []);
  }
  if (chosen === 'status') return run(ctx, ['status']);
  if (chosen === 'backup-add') return backup(ctx, ['add']);
  if (chosen === 'backup-remove') return backup(ctx, ['remove']);
  return primary(ctx, []);
}

async function run(ctx: Context, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub) {
    // In a terminal a bare `pf git` offers the actions; piped, it prints the remotes.
    return interactive() ? menu(ctx) : run(ctx, ['status']);
  }
  if (sub === 'push') return push(ctx, rest);
  if (sub === 'backup') return backup(ctx, rest);
  if (sub === 'primary') return primary(ctx, rest);
  if (sub === 'status' || sub === 'remotes') {
    const repo = needRepo(ctx);
    if (!repo) return 1;
    status(repo, loadLocalConfig(repo.root).git?.push ?? {});
    return 0;
  }
  process.stderr.write(`${badgeLabel('error', err())} unknown subcommand "${sub}"\n`);
  printUsage();
  return 2;
}

export const gitCommand: Command = {
  name: 'git',
  summary: 'Git helpers: push, backup remotes, primary remote',
  group: 'Develop',
  usage: 'pf git [push [--dry-run] [--no-secondary] [git push args] | status | backup [add|remove] | primary]  (pf gp = pf git push)',
  run,
};
