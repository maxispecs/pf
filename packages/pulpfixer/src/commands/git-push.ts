import type { Context } from '@pulpfixer/kit/context';
import { capture, runCmd } from '@pulpfixer/kit/exec';
import { loadLocalConfig, REMOTE_NAME, setLocalConfigSection, type GitPushConfig } from '@pulpfixer/kit/local-state';
import { normalizeRemote } from '@pulpfixer/kit/repo-link';
import type { Command } from '@pulpfixer/kit/types';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { badgeLabel, h2, termLine, ul } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import { planPush, resolvePrimary } from '../gitpush.js';

/**
 * `pf git-push` (`pf gp`): push to the primary remote, then to every secondary remote kept in `.pf/config.json`
 * (machine-local, gitignored). With nothing configured it is a plain `git push` to the primary remote.
 * `pf gp config` edits that file.
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

function notRepo(): number {
  process.stderr.write(`${badgeLabel('error', err())} pf git-push needs a git repository. Run it inside one.\n`);
  return 1;
}

async function push(ctx: Context, args: string[]): Promise<number> {
  const c = err();
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const noSecondary = takeFlag(rest, '--no-secondary');
  if (!ctx.repo) return notRepo();
  const repo = readRepo(ctx.repo.root);
  if (!repo) return notRepo();
  const config = loadLocalConfig(repo.root).git?.push ?? {};

  const plan = planPush({ config, branch: repo.branch, upstreamRemote: repo.upstreamRemote, remotes: repo.remotes, args: rest, secondary: !noSecondary });
  if (!plan.ok) {
    process.stderr.write(`${badgeLabel('error', c)} ${plan.error}\n`);
    return 1;
  }
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
      // A broken primary push never fans out to the secondaries.
      process.stderr.write(`${badgeLabel('error', c)} push to ${step.remote} failed${plan.steps.length > 1 ? `, so the secondary remotes were not pushed` : ''}\n`);
      return code;
    }
    failed.push(step.remote);
  }
  if (plan.steps.length > 1 && !dryRun) process.stderr.write(`\n${h2('Result', c)}\n${ul(results, c)}\n`);
  if (failed.length) {
    process.stderr.write(`${badgeLabel('error', c)} push failed for ${failed.join(', ')}; the others were pushed\n`);
    return 1;
  }
  return 0;
}

const usage = (): string => `pf gp config [add <remote> [<url>] | remove <remote> | primary <remote> | primary --unset] [--dry-run]`;

function showConfig(repo: Repo, config: GitPushConfig): void {
  const c = err();
  const primary = resolvePrimary(config, repo.upstreamRemote);
  const source = config.primary ? 'set in .pf/config.json' : repo.upstreamRemote ? 'the branch upstream' : 'the default';
  const line = (r: string, extra = '') => `${c.bold(r)}${display(repo.root, r) ? c.dim(`  ${display(repo.root, r)}`) : ''}${extra}${repo.remotes.includes(r) ? '' : c.dim('  (not a git remote here)')}`;
  const rows = [`${c.dim('primary:')}   ${line(primary, c.dim(`  (${source})`))}`];
  const secondary = (config.secondary ?? []).filter((r) => r !== primary);
  if (secondary.length) for (const r of secondary) rows.push(`${c.dim('secondary:')} ${line(r)}`);
  else rows.push(`${c.dim('secondary:')} ${c.dim('none, pf gp pushes the primary only')}`);
  process.stdout.write(`${rows.join('\n')}\n`);
  process.stderr.write(`${c.dim('Kept in .pf/config.json (this machine only, not committed). Change it with')} ${termLine(usage(), c)}\n`);
}

function save(repo: Repo, next: GitPushConfig, dryRun: boolean): number {
  const c = err();
  const w = setLocalConfigSection(repo.root, 'git', { push: Object.keys(next).length ? next : undefined }, { dryRun });
  if (!w.ok) {
    process.stderr.write(`${badgeLabel('error', c)} ${w.error}\n`);
    return 1;
  }
  return 0;
}

const invalidName = (name: string | undefined): string | null =>
  !name || !REMOTE_NAME.test(name) ? `"${name ?? ''}" is not a usable remote name (letters, digits, ".", "_" and "-")` : null;

async function config(ctx: Context, args: string[]): Promise<number> {
  const c = err();
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const unset = takeFlag(rest, '--unset');
  if (!ctx.repo) return notRepo();
  const repo = readRepo(ctx.repo.root);
  if (!repo) return notRepo();
  const current = loadLocalConfig(repo.root).git?.push ?? {};
  const [action, name, url] = rest;
  const fail = (msg: string): number => {
    process.stderr.write(`${badgeLabel('error', c)} ${msg}\n`);
    return 1;
  };
  const done = (msg: string): number => {
    process.stderr.write(`${dryRun ? c.dim('would: ') : ''}${msg}\n`);
    return 0;
  };
  const primary = resolvePrimary(current, repo.upstreamRemote);

  if (!action) {
    showConfig(repo, current);
    if (!interactive()) return 0;
    const free = repo.remotes.filter((r) => r !== primary && !(current.secondary ?? []).includes(r));
    if (!free.length) return 0;
    const chosen = await pick<string>('Also push to', [...free.map((r) => ({ value: r, label: r, hint: display(repo.root, r) })), { value: '', label: 'nothing, keep it as it is' }]);
    if (!chosen) return 0;
    const code = save(repo, { ...current, secondary: [...(current.secondary ?? []), chosen] }, dryRun);
    return code === 0 ? done(`added secondary remote ${c.bold(chosen)}`) : code;
  }

  if (action === 'add') {
    const bad = invalidName(name);
    if (bad) return fail(`${bad}. Usage: ${usage()}`);
    if (name === primary) return fail(`"${name}" is the primary remote already`);
    if ((current.secondary ?? []).includes(name!)) return done(`${name} is already a secondary remote`);
    if (!repo.remotes.includes(name!)) {
      if (!url) return fail(`this repo has no git remote "${name}". Give its URL: pf gp config add ${name} <url>`);
      if (url.startsWith('-')) return fail(`"${url}" is not a usable remote URL`);
      if (!dryRun) {
        const r = git(repo.root, 'remote', 'add', name!, url);
        if (!r.ok) return fail(`git remote add failed: ${r.stderr.trim()}`);
      }
      const shown = normalizeRemote(url) ?? 'the given URL';
      process.stderr.write(`${dryRun ? c.dim('would add') : 'added'} git remote ${c.bold(name!)} ${c.dim(shown)}\n`);
    } else if (url) {
      return fail(`this repo already has a git remote "${name}", so the URL was not used. Drop it, or change the remote with git remote set-url`);
    }
    const code = save(repo, { ...current, secondary: [...(current.secondary ?? []), name!] }, dryRun);
    return code === 0 ? done(`secondary remote ${c.bold(name!)} added: pf gp now pushes to ${primary}, then ${[...(current.secondary ?? []), name!].join(', ')}`) : code;
  }

  if (action === 'remove') {
    const bad = invalidName(name);
    if (bad) return fail(`${bad}. Usage: ${usage()}`);
    if (!(current.secondary ?? []).includes(name!)) return fail(`"${name}" is not a secondary remote (see pf gp config)`);
    const secondary = (current.secondary ?? []).filter((r) => r !== name);
    const { secondary: _drop, ...keep } = current;
    const code = save(repo, secondary.length ? { ...keep, secondary } : keep, dryRun);
    return code === 0 ? done(`secondary remote ${c.bold(name!)} removed (the git remote itself is untouched)`) : code;
  }

  if (action === 'primary') {
    if (unset) {
      const { primary: _drop, ...keep } = current;
      const code = save(repo, keep, dryRun);
      return code === 0 ? done('primary remote unset: pf gp uses the branch upstream, else origin') : code;
    }
    const bad = invalidName(name);
    if (bad) return fail(`${bad}. Usage: ${usage()}`);
    if (!repo.remotes.includes(name!)) return fail(`this repo has no git remote "${name}" (it has: ${repo.remotes.join(', ') || 'none'})`);
    const secondary = (current.secondary ?? []).filter((r) => r !== name);
    const next: GitPushConfig = { primary: name!, ...(secondary.length ? { secondary } : {}) };
    const code = save(repo, next, dryRun);
    return code === 0 ? done(`primary remote is now ${c.bold(name!)}`) : code;
  }

  process.stderr.write(`${c.dim('usage:')} ${termLine(usage(), c)}\n`);
  return 2;
}

export const gitPushCommand: Command = {
  name: 'git-push',
  summary: 'Push to the primary remote, and to the secondary remotes set up on this machine',
  group: 'Develop',
  usage: 'pf git-push [--dry-run] [--no-secondary] [git push args] | pf git-push config [...]  (shortcut: pf gp)',
  async run(ctx, args) {
    if (args[0] === 'config') return config(ctx, args.slice(1));
    return push(ctx, args);
  },
};
