import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '@pulpfixer/kit/context';
import { PACKAGE_NAME, REGISTRY_URL } from '@pulpfixer/kit/constants';
import { writeHomeFile } from '@pulpfixer/kit/config';
import { runCmd } from '@pulpfixer/kit/exec';
import { out } from '@pulpfixer/kit/ui/palette';
import { confirm, reporter } from '@pulpfixer/kit/ui/prompt';
import { compareVersions, readJson, readText, takeFlag } from '@pulpfixer/kit/util';
import { displayVersion } from '@pulpfixer/kit/version';
import { fetchLatest } from '../update/check.js';
import { updateSuiteExtensions } from '@pulpfixer/plugin-system';
import { updatePlugins } from '../plugins/manage.js';
import { refreshStackSkills, updateSkills } from '../skills/manage.js';
import { TASKS_HELPER_PATHS, findVerCopies, isTasksHelper, resolveTasksHelper } from './repo.js';
import { cliRevision, findVersionsRoot, resolveVerCli } from './ver.js';
import type { Command } from '@pulpfixer/kit/types';

/** Where the repo keeps its copy of the /ver CLI, if it has one. */
export function repoVerCli(root: string): string | null {
  const pkg = readJson<{ scripts?: Record<string, string> }>(root, 'package.json');
  const candidates: string[] = [];
  for (const key of ['ver', 'versions', 'version:list']) {
    const m = /(?:^|\s)((?:\.\/)?[\w./-]*\.mjs)/.exec(pkg?.scripts?.[key] ?? '');
    if (m) candidates.push(m[1]!);
  }
  candidates.push('scripts/version.mjs', 'tools/version.mjs', 'scripts/ver.mjs');
  for (const rel of candidates) {
    const text = readText(root, rel);
    if (text && text.includes('versions.json') && /major\.minor/.test(text)) return path.join(root, rel);
  }
  return null;
}

/** Repo-relative paths of the repo's copies of the /ver CLI (the script-based detection also finds copies that predate CLI_VERSION). */
function verCopies(root: string): string[] {
  const found = new Set<string>(findVerCopies(root, readJson<{ scripts?: Record<string, string> }>(root, 'package.json')?.scripts?.ver));
  const detected = repoVerCli(root);
  if (detected) found.add(path.normalize(path.relative(root, detected)));
  return [...found];
}

/** Repo-relative paths of the repo's copies of the /pnpm helper. */
function tasksCopies(root: string): string[] {
  return TASKS_HELPER_PATHS.filter((rel) => isTasksHelper(readText(root, rel)));
}

/** Whether `pf update` has helper copies to refresh from this directory. */
function hasRepoTools(ctx: Context): boolean {
  return !!findVersionsRoot(ctx.cwd) || (!!ctx.repo && tasksCopies(ctx.repo.root).length > 0);
}

/**
 * Refresh the repo's copies of the stack helpers (the /ver CLI and the /pnpm helper) from the newest
 * ones pf has: the skills in ~/.pf/skills, else the bundled files. Never installs a helper (pf repo
 * does), never touches versions.json or package.json, never commits. `check` only reports.
 */
function refreshRepoTools(ctx: Context, dryRun: boolean, check = false): number {
  const r = reporter(out());
  const write = !dryRun && !check;
  const would = check ? 'can update' : 'would update';

  const verRoot = findVersionsRoot(ctx.cwd);
  if (verRoot) {
    r.step('Repo versioning CLI');
    const source = resolveVerCli();
    const latest = cliRevision(source);
    const copies = verCopies(verRoot);
    if (!copies.length) r.info(`no copy of the ver CLI in ${verRoot}: pf ver uses its own copy (revision ${latest})`);
    for (const rel of copies) {
      const file = path.join(verRoot, rel);
      const mine = cliRevision(file);
      if (latest > mine) {
        if (!write) r.info(`${would} ${rel} from revision ${mine} to ${latest}`);
        else {
          fs.copyFileSync(source, file);
          r.ok(`updated ${rel} from revision ${mine} to ${latest} (not committed)`);
        }
      } else if (latest === mine) r.ok(`${rel} is current (revision ${mine})`);
      else r.info(`${rel} is newer (revision ${mine}) than pf's copy (revision ${latest}): not overwritten`);
    }
  }

  const pnpmRoot = ctx.repo?.root ?? verRoot;
  const helpers = pnpmRoot ? tasksCopies(pnpmRoot) : [];
  if (pnpmRoot && helpers.length) {
    r.step('Repo pnpm helper');
    const source = resolveTasksHelper();
    const text = readText(source);
    for (const rel of helpers) {
      if (readText(pnpmRoot, rel) === text) r.ok(`${rel} is current`);
      else if (!write) r.info(`${would} ${rel}`);
      else {
        fs.copyFileSync(source, path.join(pnpmRoot, rel));
        r.ok(`updated ${rel} (not committed; pf repo rewires package.json if the helper gained commands)`);
      }
    }
  }
  return 0;
}

/**
 * Plugins, skills and the suite extensions in Cursor (Background Tone) follow pf: `pf update` updates them too. The stack skills
 * (ver, pnpm) are installed into ~/.pf/skills when missing; the repo refresh then copies from there.
 */
async function refreshAddons(check: boolean, dryRun: boolean): Promise<number> {
  const r = reporter(out());
  r.step('Plugins');
  const plugins = await updatePlugins([], { check, dryRun });
  r.step('Skills');
  const stack = refreshStackSkills({ check, dryRun });
  const skills = updateSkills([], { check, dryRun, skipStack: true });
  r.step('Cursor extensions');
  const extensions = await updateSuiteExtensions({ check, dryRun });
  return plugins || stack || skills || extensions;
}

export const updateCommand: Command = {
  name: 'update',
  summary: 'Update pf, its plugins, suite extensions, the ver and pnpm skills and this repo\'s copies from cellars',
  group: 'Tools',
  usage: 'pf update [--check] [--yes] [--dry-run]',
  async run(ctx, args) {
    const rest = [...args];
    const check = takeFlag(rest, '--check');
    const yes = takeFlag(rest, '--yes', '-y');
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const repoOnly = takeFlag(rest, '--repo-only');
    const c = out();
    const r = reporter(c);

    if (repoOnly) return refreshRepoTools(ctx, dryRun, check);

    r.step('pf');
    const found = fetchLatest();
    if (!found.version) {
      r.fail(`could not reach ${REGISTRY_URL}: ${found.error}`);
      r.info('Check NPM_TOKEN and the auth line in ~/.npmrc (pf setup fixes the latter)');
      await refreshAddons(check, dryRun);
      refreshRepoTools(ctx, dryRun, check);
      return 1;
    }
    writeHomeFile('state.json', JSON.stringify({ checkedAt: Date.now(), latest: found.version }));
    const cmp = compareVersions(found.version, ctx.version);
    if (cmp <= 0) {
      r.ok(`pf v${displayVersion()} is the latest${cmp < 0 ? ` (registry has v${displayVersion(found.version)})` : ''}`);
      const skills = await refreshAddons(check, dryRun);
      return refreshRepoTools(ctx, dryRun, check) || skills;
    }
    r.warn(`v${displayVersion(found.version)} is available (you have v${displayVersion()})`);
    if (check) {
      const skills = await refreshAddons(true, dryRun);
      return refreshRepoTools(ctx, dryRun, true) || skills;
    }
    if (!(yes || (await confirm(`Install pf v${displayVersion(found.version)} now?`, true, { flag: '--yes' })))) {
      r.info('skipped');
      return await refreshAddons(false, dryRun);
    }
    const code = await runCmd(
      { argv: ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`, '--registry', REGISTRY_URL] },
      { dryRun },
    );
    if (code !== 0) {
      r.fail('npm install failed (a global prefix owned by root needs sudo, or fix its permissions)');
      return code;
    }
    if (!dryRun) r.ok(`updated to v${displayVersion(found.version)}`);
    const skills = await refreshAddons(false, dryRun);
    if (dryRun) return skills;
    // The repo refresh must use the new version's bundled fallback files, so hand over to the new binary.
    if (hasRepoTools(ctx)) return (await runCmd({ argv: ['pf', 'update', '--repo-only'], cwd: ctx.cwd }, { quiet: true })) || skills;
    return skills;
  },
};
