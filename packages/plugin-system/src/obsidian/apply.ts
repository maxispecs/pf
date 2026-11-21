import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from '@pulpfixer/kit/constants';
import { termLine } from '@pulpfixer/kit/ui/text';
import { out } from '@pulpfixer/kit/ui/palette';
import { confirm, reporter } from '@pulpfixer/kit/ui/prompt';
import { interactive } from '@pulpfixer/kit/util';
import type { ObsidianConfig } from './config.js';
import { describeObsidianPlan, isEmptyObsidianPlan, planObsidian, readVault, type FileChange, type ObsidianPlan } from './plan.js';
import { obsidianRunning } from './vaults.js';

/** Where the old copies of the files a run changes are kept: not inside the vault, so they never sync or show up in it. */
export function backupDir(vault: string, now: Date = new Date()): string {
  const slug = `${path.basename(vault).replace(/[^\w.-]+/g, '_') || 'vault'}-${createHash('sha1').update(vault).digest('hex').slice(0, 8)}`;
  return path.join(pfHome(), 'sys', 'backups', 'obsidian', slug, now.toISOString().replace(/[:.]/g, '-'));
}

/** The absolute path of a file inside the vault's `.obsidian`, refusing anything that would leave it. */
export function vaultFile(vault: string, rel: string): string {
  const base = path.resolve(vault, '.obsidian');
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) throw new Error(`${rel} is outside ${base}`);
  return file;
}

/** Write the plan's files: the old ones are copied to `backup` first, each new one goes through a temp file and a rename. */
export function writePlan(vault: string, files: FileChange[], backup: string): { written: string[]; error?: string } {
  const written: string[] = [];
  for (const f of files) {
    try {
      const target = vaultFile(vault, f.file);
      if (!f.isNew && fs.existsSync(target)) {
        const copy = path.join(backup, f.file);
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.copyFileSync(target, copy);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.pf-tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(f.next, null, 2) + '\n');
      fs.renameSync(tmp, target);
      written.push(f.file);
    } catch (e) {
      return { written, error: `${f.file}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { written };
}

export interface ObsidianRun {
  /** Exit code. */
  code: number;
  /** The preset ended up applied (already matching counts), so the feature can be recorded. */
  applied: boolean;
}

/** Plan a vault, show it, and (after a confirmation) write it. `--dry-run` writes nothing. */
export async function applyObsidian(cfg: ObsidianConfig, vault: string, o: { yes: boolean; dryRun: boolean; running?: () => boolean }): Promise<ObsidianRun> {
  const c = out();
  const r = reporter(c);
  const w = (s: string) => process.stdout.write(s + '\n');
  const state = readVault(vault, cfg);
  if (state.problems.length) {
    for (const p of state.problems) r.fail(p);
    return { code: 1, applied: false };
  }
  const plan: ObsidianPlan = planObsidian(cfg, state);
  w(c.bold(`Vault ${vault}`));
  for (const line of describeObsidianPlan(plan, c)) w(line);
  const hint = (): void => {
    if (plan.missingPlugins.length || plan.missingTheme) {
      r.info('pf does not install plugins or themes: add them in Obsidian (Settings, Community plugins / Appearance), then run');
      w(`    ${termLine(`pf suite enable obsidian --vault "${vault}"`, c)}`);
    }
  };

  if (isEmptyObsidianPlan(plan)) {
    r.ok('the vault already matches the preset');
    hint();
    return { code: 0, applied: true };
  }
  if (o.dryRun) {
    r.info(`would change ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} in ${path.join(vault, '.obsidian')} (old copies are kept)`);
    hint();
    return { code: 0, applied: false };
  }
  if ((o.running ?? obsidianRunning)()) r.warn('Obsidian is running: it may overwrite these files when it closes. Quit it first, and start it again afterwards.');
  if (!o.yes) {
    const yes = await confirm('Apply to this vault?', false, { flag: '--yes' });
    if (!yes) {
      r.info('nothing changed');
      return { code: interactive() ? 0 : 1, applied: false };
    }
  }
  const backup = backupDir(vault);
  const res = writePlan(vault, plan.files, backup);
  if (res.error) {
    r.fail(`could not write ${res.error}`);
    if (res.written.length) r.warn(`already written: ${res.written.join(', ')} (old copies in ${backup})`);
    return { code: 1, applied: false };
  }
  r.ok(`changed ${res.written.length} file${res.written.length === 1 ? '' : 's'}: ${res.written.join(', ')}`);
  if (fs.existsSync(backup)) r.info(`previous files kept in ${backup}`);
  hint();
  return { code: 0, applied: true };
}
