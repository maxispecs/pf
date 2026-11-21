import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { compareVersions, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { applyPreset, fail, prepare, short } from '../apply.js';
import { APPS, findApp } from '../apps/index.js';
import { capturePreset, describePlan, isEmptyPlan } from '../plan.js';
import { detectObsidian } from '../obsidian/vaults.js';
import { cachedPresets, searchPresets } from '../presets.js';
import { installSuite, updateSuiteExtensions } from '../suite.js';

const USAGE = `Usage:
  pf sys                                 list presets, with what this machine has
  pf sys diff <preset>                   fetch the latest preset and show what would change
  pf sys apply <preset> [--yes] [--dry-run] [--offline]
                                         fetch the latest preset and apply it (additive)
  pf sys apply suite                     same as pf suite enable: the default features of the suite (the Cursor setup)
  pf sys update [--check] [--dry-run] [--offline]
                                         update the suite extensions that are already installed
  pf sys capture <app> [--setting <key>]...
                                         print a preset.json built from this machine`;

/** `pf sys` / `pf sys list`. */
export function listPresets(): number {
  const c = out();
  const w = (s: string) => process.stdout.write(s + '\n');
  const cached = cachedPresets();
  const remote = searchPresets();
  const names = [...new Set([...cached.map((p) => p.name), ...(remote.presets ?? []).map((p) => p.name)])].sort();
  if (!names.length) {
    w(c.dim('no presets found.'));
  } else {
    const width = Math.max(8, ...names.map((n) => n.length));
    w(c.bold('Presets') + c.dim('  @pulpfixer/preset-<name>, applied with pf sys apply <name> (the suite is pf suite)'));
    for (const name of names) {
      const mine = cached.find((p) => p.name === name);
      const latest = remote.presets?.find((p) => p.name === name);
      const appId = mine?.preset?.app ?? name;
      const app = findApp(appId);
      const have = mine ? `v${short(mine.version)}` : 'not fetched';
      const state = mine && !mine.preset
        ? c.red(`unusable: ${mine.problem}`)
        : appId === 'obsidian'
          ? detectObsidian()
            ? c.green('Obsidian found') + c.dim(' (pf suite enable obsidian)')
            : c.dim('Obsidian not found here')
          : !app
          ? c.dim('no adapter for this app')
          : !app.detect()
            ? c.dim(`${app.label} not found here`)
            : latest && mine && compareVersions(latest.version, mine.version) > 0
              ? c.yellow(`v${short(latest.version)} on the registry`)
              : c.green(app.label + ' found');
      const summary = mine?.preset?.summary || latest?.description || '';
      w(`  ${c.bold(name.padEnd(width))}  ${c.dim(have.padEnd(11))}  ${state}${summary ? `  ${c.dim(summary)}` : ''}`);
    }
  }
  w('');
  w(c.bold('Apps') + c.dim('  what presets can configure'));
  for (const a of APPS) w(`  ${c.bold(a.id.padEnd(8))}  ${a.detect() ? c.green('found') : c.dim('not found')}  ${c.dim(a.settingsPath())}`);
  if (remote.error) {
    process.stderr.write(`${badgeLabel('warning', err())} could not search the registry: ${remote.error}\n`);
    return cached.length ? 0 : 1;
  }
  w(`\n${c.dim('apply:')} ${termLine('pf sys apply <preset>', c)}`);
  return 0;
}

/** `pf sys capture <app>`: a preset.json from this machine, on stdout. */
function capturePrint(appId: string, keys: string[]): number {
  const app = findApp(appId);
  if (!app) return fail(`no adapter for "${appId}" (apps: ${APPS.map((a) => a.id).join(', ')})`);
  if (!app.detect()) return fail(`${app.label} does not seem to be installed here`);
  const state = app.readState();
  if (state.extensions === null || state.settings === null) {
    for (const p of state.problems) fail(p);
    return 1;
  }
  const { preset, missing } = capturePreset(app.id, app.label, { extensions: state.extensions, settings: state.settings }, keys);
  process.stdout.write(JSON.stringify(preset, null, 2) + '\n');
  const c = err();
  for (const k of missing) process.stderr.write(`${badgeLabel('warning', c)} ${k} is not set in ${state.settingsPath}, left out\n`);
  process.stderr.write(
    `${c.dim(`Save as packages/preset-${app.id}/preset.json, prune it, then: pnpm ver bump packages/preset-${app.id} minor and publish.`)}\n`,
  );
  return 0;
}

export const sysCommand: Command = {
  name: 'sys',
  summary: 'Apply standard configuration presets to apps on this machine (Cursor)',
  group: 'Tools',
  usage: 'pf sys [list | diff <preset> | apply <preset> [--yes] [--dry-run] [--offline] | update [--check] [--dry-run] [--offline] | capture <app> [--setting <key>]]',
  async run(_ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const yes = takeFlag(rest, '--yes', '-y');
    const offline = takeFlag(rest, '--offline');
    const check = takeFlag(rest, '--check');
    const keys: string[] = [];
    for (let k = takeOption(rest, '--setting'); k !== undefined; k = takeOption(rest, '--setting')) keys.push(k);
    const sub = rest.shift() ?? 'list';
    const unknownFlag = rest.find((a) => a.startsWith('-'));
    if (unknownFlag) {
      process.stderr.write(`${badgeLabel('error', err())} unknown option ${unknownFlag}\n${USAGE}\n`);
      return 2;
    }

    if (sub === 'list' || sub === 'ls') return listPresets();
    if (sub === 'diff' || sub === 'apply') {
      const name = rest[0];
      if (!name) {
        process.stderr.write(`${badgeLabel('error', err())} which preset? (pf sys list)\n${USAGE}\n`);
        return 2;
      }
      if (name === 'suite') {
        // The suite is not a preset any more: pf suite owns it. Kept so older docs and one-liners still work.
        return installSuite({ yes, dryRun: dryRun || sub === 'diff', offline });
      }
      const target = prepare(name, offline);
      if (!target) return 1;
      if (sub === 'diff') {
        const c = out();
        const lines = describePlan(target.plan, c);
        for (const l of lines) process.stdout.write(l + '\n');
        for (const e of target.packageErrors) fail(e);
        if (isEmptyPlan(target.plan)) process.stdout.write(`  ${c.green('✔')} ${target.app.label} already matches the preset\n`);
        return 0;
      }
      return applyPreset(target, { yes, dryRun });
    }
    if (sub === 'update') return updateSuiteExtensions({ check: check, dryRun, offline });
    if (sub === 'capture') {
      const app = rest[0];
      if (!app) {
        process.stderr.write(`${badgeLabel('error', err())} which app? (${APPS.map((a) => a.id).join(', ')})\n${USAGE}\n`);
        return 2;
      }
      return capturePrint(app, keys);
    }
    process.stderr.write(`${badgeLabel('error', err())} unknown subcommand "${sub}"\n${USAGE}\n`);
    return 2;
  },
};
