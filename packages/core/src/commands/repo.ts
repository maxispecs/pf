import fs from 'node:fs';
import path from 'node:path';
import { buildContext, type Context } from '@pulpfixer/kit/context';
import { detectDeploy, detectProduction, detectStaging } from '@pulpfixer/kit/detect/deploy';
import { findDeployHelpers, type DeployHelper } from '@pulpfixer/kit/detect/helpers';
import { capture, formatCmd, runCmd } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, h2, termLine, ul } from '@pulpfixer/kit/ui/text';
import { exists, interactive, readText, takeFlag } from '@pulpfixer/kit/util';
import { packageRoot } from '@pulpfixer/kit/version';
import type { Command } from '@pulpfixer/kit/types';
import { startAgent } from '../agent/launch.js';
import { homeSkillFile } from '../skills/stack.js';
import { runDeployAuto } from './deploy.js';
import { cliRevision, resolveVerCli } from './ver.js';

/** Path of the /pnpm skill helper bundled with pf (`pnpm ask`, `pnpm doc`, `pnpm deploy:staging`); the offline fallback. */
export function bundledTasksHelper(): string {
  return path.join(packageRoot(), 'assets', 'tasks.mjs');
}

/**
 * The /pnpm helper pf copies into repos: the `pnpm` skill in pf's own folder (kept current by
 * `pf update`), else the bundled copy. The helper has no revision, so the registry copy counts as latest.
 */
export function resolveTasksHelper(skillsDir?: string): string {
  return homeSkillFile('pnpm', path.join('scripts', 'tasks.mjs'), skillsDir) ?? bundledTasksHelper();
}

/** Repo-relative paths where a repo may keep its copy of the pnpm helper. */
export const TASKS_HELPER_PATHS = ['scripts/tasks.mjs', 'scripts/pnpm-tasks.mjs'];

/** Marker line of the pnpm helper, to tell it from an unrelated tasks.mjs. */
export const isTasksHelper = (text: string | null): boolean => !!text && text.includes('@skill pnpm');

/** Has `pf repo` (or the /pnpm and /ver skills it installs) been run in this repo? True with a pnpm helper copy or a `versions.json`. */
export function isRepoSetUp(root: string): boolean {
  return exists(root, 'versions.json') || TASKS_HELPER_PATHS.some((t) => isTasksHelper(readText(root, t)));
}

const isVerCli = (file: string): boolean => (readText(file) ?? '').includes('const CLI_VERSION');

/** Repo-relative paths of every copy of the ver CLI: tracked or untracked `*version.mjs` files, plus the one the `ver` script runs. */
export function findVerCopies(root: string, verScript?: string): string[] {
  const found = new Set<string>();
  const git = capture(['git', 'ls-files', '-co', '--exclude-standard', '--', '*version.mjs'], { cwd: root });
  const listed = git.ok ? git.stdout.split('\n').filter(Boolean) : ['scripts/version.mjs', 'tools/version.mjs'];
  const fromScript = verScript ? /node\s+(\S+\.mjs)/.exec(verScript)?.[1] : undefined;
  for (const rel of [...(fromScript ? [fromScript] : []), ...listed, 'scripts/ver.mjs']) {
    if (fs.existsSync(path.join(root, rel)) && isVerCli(path.join(root, rel))) found.add(path.normalize(rel));
  }
  return [...found];
}

interface Pkg {
  scripts?: Record<string, string>;
  scriptsInfo?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

function readPkg(root: string): { pkg: Pkg; raw: string } | null {
  const raw = readText(root, 'package.json');
  if (raw === null) return null;
  try {
    return { pkg: JSON.parse(raw) as Pkg, raw };
  } catch {
    return null;
  }
}

/** Write package.json keeping its indentation and trailing newline. */
function writePkg(root: string, pkg: Pkg, raw: string): void {
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? '  ';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
}

/** Add the `ver` script (or `versions` when `ver` runs something else) and its `scriptsInfo` entry. Returns what changed. */
export function wireVerScript(pkg: Pkg, cliRel: string): string[] {
  const value = `node ${cliRel.split(path.sep).join('/')}`;
  const scripts = (pkg.scripts ??= {});
  const name = scripts.ver === undefined || /version\.mjs|ver\.mjs/.test(scripts.ver) ? 'ver' : 'versions';
  const changes: string[] = [];
  if (scripts[name] !== value) {
    changes.push(`${scripts[name] === undefined ? 'added' : 'updated'} script ${name}: ${value}`);
    scripts[name] = value;
  }
  if (pkg.scriptsInfo) {
    const described = Object.values(pkg.scriptsInfo).some((g) => name in g);
    if (!described) {
      const group = Object.keys(pkg.scriptsInfo).find((g) => g.toLowerCase() === 'tools') ?? 'Tools';
      (pkg.scriptsInfo[group] ??= {})[name] = 'List versions and bump commands';
      changes.push(`described ${name} in scriptsInfo (${group})`);
    }
  }
  return changes;
}

/** pnpm commands through the bundled /pnpm skill helper. */
async function setupPnpm(root: string, dryRun: boolean, done: string[]): Promise<number> {
  const c = err();
  const helper = resolveTasksHelper();
  if (!fs.existsSync(helper)) {
    process.stderr.write(`${badgeLabel('error', c)} the pnpm helper is missing (${helper}). Reinstall pf.\n`);
    return 1;
  }
  if (!exists(root, 'package.json')) {
    done.push('pnpm commands: skipped, no package.json at the repo root');
    return 0;
  }
  const targets = TASKS_HELPER_PATHS;
  const before = targets.map((t) => readText(root, t));
  const pkgBefore = readText(root, 'package.json');
  const code = await runCmd({ argv: [process.execPath, helper, 'setup', '--root', root, ...(dryRun ? ['--dry-run'] : [])], cwd: root }, { quiet: true });
  if (code !== 0) return code;
  if (dryRun) return 0;
  const bundled = readText(helper);
  targets.forEach((t, i) => {
    const now = readText(root, t);
    if (now !== bundled) return;
    done.push(before[i] === null ? `pnpm helper: installed ${t}` : before[i] === now ? `pnpm helper: ${t} already current` : `pnpm helper: updated ${t}`);
  });
  if (readText(root, 'package.json') !== pkgBefore) done.push('pnpm commands: package.json scripts and scriptsInfo updated');
  else done.push('pnpm commands: package.json already wired');
  return 0;
}

/** Versioning through the bundled /ver CLI: set it up, or bring every copy up to pf's revision. */
async function setupVer(root: string, dryRun: boolean, done: string[]): Promise<number> {
  const c = err();
  const bundled = resolveVerCli();
  if (!fs.existsSync(bundled)) {
    process.stderr.write(`${badgeLabel('error', c)} the ver CLI is missing (${bundled}). Reinstall pf.\n`);
    return 1;
  }
  const rev = cliRevision(bundled);
  const loaded = readPkg(root);
  const copies = findVerCopies(root, loaded?.pkg.scripts?.ver);
  const write = (rel: string) => {
    if (dryRun) return;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(bundled, path.join(root, rel));
  };

  let cli: string;
  if (copies.length === 0) {
    cli = ['scripts/version.mjs', 'tools/version.mjs', 'scripts/ver.mjs'].find((p) => !exists(root, p))!;
    write(cli);
    done.push(`ver CLI: ${dryRun ? 'would install' : 'installed'} ${cli} (revision ${rev})`);
  } else {
    // The copy the `ver` script runs comes first, so it is the one wired below.
    cli = copies[0]!;
    for (const rel of copies) {
      const have = cliRevision(path.join(root, rel));
      if (have < rev) {
        write(rel);
        done.push(`ver CLI: ${dryRun ? 'would update' : 'updated'} ${rel} (revision ${have} -> ${rev})`);
      } else if (have > rev) done.push(`ver CLI: ${rel} is newer than pf's copy (revision ${have} > ${rev}); left as is, run pf update`);
      else done.push(`ver CLI: ${rel} already current (revision ${rev})`);
    }
  }

  const runVer = (args: string[]) =>
    runCmd({ argv: [process.execPath, dryRun ? bundled : path.join(root, cli), ...args, '--root', root], cwd: root }, { quiet: true });
  if (!exists(root, 'versions.json')) {
    const code = await runVer(['init', ...(dryRun ? ['--dry-run'] : [])]);
    if (code !== 0) return code;
    done.push(`versions: ${dryRun ? 'would create' : 'created'} versions.json`);
  } else done.push('versions: versions.json already set up');

  if (!loaded) {
    done.push(`ver script: no package.json, run ${termLine(`node ${cli} list`, c)}`);
    return 0;
  }
  // Re-read: the pnpm step may have just written package.json.
  const { pkg, raw } = readPkg(root)!;
  const changes = wireVerScript(pkg, cli);
  if (changes.length && !dryRun) writePkg(root, pkg, raw);
  for (const ch of changes) done.push(`ver script: ${dryRun ? `would have ${ch}` : ch}`);
  if (!changes.length) done.push('ver script: package.json already wired');
  return 0;
}

export type DeployKey = 'deploy' | 'deploy:staging' | 'deploy:production';

/** What the agent is asked first. The skill carries the method; the ranked helpers are only hints. */
export function deploySetupPrompt(helpers: DeployHelper[], key: DeployKey = 'deploy'): string {
  const hints = helpers.length
    ? `pf found these scripts at the repo root, best guess first: ${helpers.map((h) => `${h.file} (${h.reasons.join(', ')})`).join('; ')}. Check them yourself.`
    : 'pf found no helper script at the repo root; look in the docs, a Makefile, a justfile or cli/.';
  return `Set up pf deploy for this repo: call pf_skill with name "deploy-setup" and follow it. ${hints} The user chose the pf.json key "${key}". Use that key and do not ask. This session exits when you finish. Write pf.json only, then stop. pf will preview the deploy after you exit. Do not run the deploy.`;
}

/** The environment question, asked here so the agent can run once and exit. No terminal means the plain `deploy` key. */
async function chooseDeployKey(): Promise<DeployKey | null> {
  if (!interactive()) return 'deploy';
  return pick<DeployKey>('Which pf.json key should this deploy use?', [
    { value: 'deploy', label: 'deploy', hint: 'just deploy, pf asks first' },
    { value: 'deploy:staging', label: 'deploy:staging', hint: 'staging' },
    { value: 'deploy:production', label: 'deploy:production', hint: 'production, pf asks first' },
  ]);
}

interface DeployStep {
  /** The deploy pf already resolves (`pf d`), printed in the summary. */
  resolved: string | null;
  helpers: DeployHelper[];
  /** Start the agent after the summary. */
  agent: boolean;
}

/**
 * The deploy part of `pf repo`: report what `pf d` runs, or find a custom helper and offer to let the
 * agent wire it (the agent takes over the terminal, so it starts after the summary).
 */
async function planDeploy(ctx: Context, opts: { force: boolean; dryRun: boolean }, done: string[]): Promise<DeployStep> {
  const root = ctx.repo!.root;
  const found = (['staging', 'production', 'repo'] as const)
    .map((env) => ({ env, step: (env === 'staging' ? detectStaging(ctx) : env === 'production' ? detectProduction(ctx) : detectDeploy(ctx)).steps[0] }))
    .find((x) => x.step);
  const resolved = found ? `pf d runs ${formatCmd(found.step!.cmd, root)} (${found.step!.source}, ${found.env === 'repo' ? 'bare deploy' : found.env})` : null;
  if (resolved && !opts.force) {
    done.push(`deploy: ${resolved}`);
    return { resolved, helpers: [], agent: false };
  }
  const helpers = findDeployHelpers(root);
  const names = helpers.map((h) => `${h.file}${h.serverOnly ? ' (server only)' : ''}`).join(', ');
  if (opts.dryRun) {
    done.push(helpers.length || opts.force ? `deploy: would start the agent to wire pf d${names ? ` (candidates: ${names})` : ''}` : 'deploy: nothing found for pf d');
    return { resolved, helpers, agent: false };
  }
  if (helpers.length === 0 && !opts.force) {
    done.push('deploy: nothing found for pf d, run pf rp --deploy to let the agent look');
    return { resolved, helpers, agent: false };
  }
  if (!opts.force && !interactive()) {
    done.push(`deploy: found ${names}, run pf rp --deploy in a terminal to wire pf d to it`);
    return { resolved, helpers, agent: false };
  }
  if (!opts.force && !(await confirm(`Found ${names}. Let the agent read it and wire pf d?`, true))) {
    done.push('deploy: skipped, run pf rp --deploy later');
    return { resolved, helpers, agent: false };
  }
  return { resolved, helpers, agent: true };
}

export const repoCommand: Command = {
  name: 'repo',
  summary: 'Hook pf tools into this repo (pnpm commands, versioning, deploy), or update them',
  group: 'Tools',
  usage: 'pf repo [--dry-run] [--no-pnpm] [--no-ver] [--no-deploy] [--deploy]',
  async run(ctx: Context, args: string[]) {
    const c = err();
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const noPnpm = takeFlag(rest, '--no-pnpm');
    const noVer = takeFlag(rest, '--no-ver');
    const noDeploy = takeFlag(rest, '--no-deploy');
    const forceDeploy = takeFlag(rest, '--deploy');
    if (!ctx.repo) {
      process.stderr.write(`${badgeLabel('error', c)} pf repo needs a repo. Run it inside a project directory.\n`);
      return 1;
    }
    const root = ctx.repo.root;
    const done: string[] = [];

    if (!noPnpm) {
      process.stderr.write(`${h2('pnpm commands', c)}\n`);
      const code = await setupPnpm(root, dryRun, done);
      if (code !== 0) return code;
    }
    if (!noVer) {
      process.stderr.write(`\n${h2('Versioning', c)}\n`);
      const code = await setupVer(root, dryRun, done);
      if (code !== 0) return code;
    }

    let deploy: DeployStep | null = null;
    if (!noDeploy) {
      process.stderr.write(`\n${h2('Deploy', c)}\n`);
      deploy = await planDeploy(ctx, { force: forceDeploy, dryRun }, done);
    }

    process.stderr.write(`\n${h2(dryRun ? 'Would do (dry run, nothing written)' : 'Done', c)}\n${ul(done, c)}\n`);
    const next = [!noPnpm && exists(root, 'package.json') ? termLine('pnpm ask', c) : '', !noVer ? termLine('pf ver', c) : ''].filter(Boolean);
    if (next.length) process.stderr.write(`${c.dim('Next:')} ${next.join(c.dim(', '))}${c.dim('. Nothing is committed; rerun pf repo after pf update to refresh the tools.')}\n`);

    if (deploy?.agent) {
      process.stderr.write(`\n${h2('Deploy setup (agent)', c)}\n`);
      const key = await chooseDeployKey();
      if (!key) return 130;
      if (!interactive()) process.stderr.write(`${c.dim('no terminal, using the deploy key')}\n`);
      const code = await startAgent(ctx, { prompt: deploySetupPrompt(deploy.helpers, key), once: true });
      if (code !== 0) return code;
      // The agent was told to exit when the file was written. Show what pf d resolves to now.
      process.stderr.write(`\n${c.dim('pf d now:')}\n`);
      const check = await runDeployAuto(buildContext(ctx.cwd), { dryRun: true });
      if (check === 0) process.stderr.write(`${badgeLabel('success', c)} wired. pf d will ask before it runs; nothing was deployed.\n`);
      return check;
    }
    return 0;
  },
};
