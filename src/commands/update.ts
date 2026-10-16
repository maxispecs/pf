import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../context.js';
import { PACKAGE_NAME, REGISTRY_URL } from '../constants.js';
import { writeHomeFile } from '../config.js';
import { runCmd } from '../exec.js';
import { out } from '../ui/palette.js';
import { confirm, reporter } from '../ui/prompt.js';
import { compareVersions, readJson, readText, takeFlag } from '../util.js';
import { displayVersion } from '../version.js';
import { fetchLatest } from '../update/check.js';
import { bundledVerCli, cliRevision, findVersionsRoot } from './ver.js';
import type { Command } from './types.js';

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

/** Refresh the repo's /ver CLI copy when the bundled one is newer. Never touches versions.json. */
function refreshRepoCli(ctx: Context, dryRun: boolean): number {
  const c = out();
  const r = reporter(c);
  const root = findVersionsRoot(ctx.cwd);
  if (!root) return 0;
  r.step('Repo versioning CLI');
  const copy = repoVerCli(root);
  const bundled = cliRevision(bundledVerCli());
  if (!copy) {
    r.info(`no copy of the ver CLI in ${root}: pf ver uses its bundled copy (revision ${bundled})`);
    return 0;
  }
  const mine = cliRevision(copy);
  const rel = path.relative(root, copy);
  if (bundled > mine) {
    if (dryRun) r.info(`would update ${rel} from revision ${mine} to ${bundled}`);
    else {
      fs.copyFileSync(bundledVerCli(), copy);
      r.ok(`updated ${rel} from revision ${mine} to ${bundled} (not committed)`);
    }
  } else if (bundled === mine) r.ok(`${rel} is current (revision ${mine})`);
  else r.info(`${rel} is newer (revision ${mine}) than this pf (revision ${bundled}): not overwritten`);
  return 0;
}

export const updateCommand: Command = {
  name: 'update',
  summary: 'Update pf from the cellars registry',
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

    if (repoOnly) return refreshRepoCli(ctx, dryRun);

    r.step('pf');
    const found = fetchLatest();
    if (!found.version) {
      r.fail(`could not reach ${REGISTRY_URL}: ${found.error}`);
      r.info('Check NPM_TOKEN and the auth line in ~/.npmrc (pf setup fixes the latter)');
      refreshRepoCli(ctx, dryRun);
      return 1;
    }
    writeHomeFile('state.json', JSON.stringify({ checkedAt: Date.now(), latest: found.version }));
    const cmp = compareVersions(found.version, ctx.version);
    if (cmp <= 0) {
      r.ok(`pf v${displayVersion()} is the latest${cmp < 0 ? ` (registry has v${displayVersion(found.version)})` : ''}`);
      return refreshRepoCli(ctx, dryRun);
    }
    r.warn(`v${displayVersion(found.version)} is available (you have v${displayVersion()})`);
    if (check) return 0;
    if (!(yes || (await confirm(`Install pf v${displayVersion(found.version)} now?`, true, { flag: '--yes' })))) {
      r.info('skipped');
      return 0;
    }
    const code = await runCmd(
      { argv: ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`, '--registry', REGISTRY_URL] },
      { dryRun },
    );
    if (code !== 0) {
      r.fail('npm install failed (a global prefix owned by root needs sudo, or fix its permissions)');
      return code;
    }
    if (dryRun) return 0;
    r.ok(`updated to v${displayVersion(found.version)}`);
    // The repo refresh must use the new version's bundled CLI, so hand over to the new binary.
    if (findVersionsRoot(ctx.cwd)) return runCmd({ argv: ['pf', 'update', '--repo-only'], cwd: ctx.cwd }, { quiet: true });
    return 0;
  },
};
