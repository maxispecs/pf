import fs from 'node:fs';
import path from 'node:path';
import type { Command } from '@pulpfixer/kit/types';
import { captureAsync, runCmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { confirm, reporter } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { compareVersions, interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { APPS, findApp, type AppAdapter, type AppState } from '../apps/index.js';
import { parseJsonc, sameJson, setTopLevelKeys } from '../jsonc.js';
import { capturePreset, describePlan, isEmptyPlan, planPreset, settingsToWrite, type Plan } from '../plan.js';
import { cachedPresets, fetchPreset, presetPackage, searchPresets, type FetchedPreset } from '../presets.js';

const USAGE = `Usage:
  pf sys                                 list presets, with what this machine has
  pf sys diff <preset>                   fetch the latest preset and show what would change
  pf sys apply <preset> [--yes] [--dry-run] [--offline]
                                         fetch the latest preset and apply it (additive)
  pf sys capture <app> [--setting <key>]...
                                         print a preset.json built from this machine`;

const short = (v: string): string => v.replace(/^(\d+\.\d+)\.0$/, '$1');

function fail(message: string): number {
  process.stderr.write(`${badgeLabel('error', err())} ${message}\n`);
  return 1;
}

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
    w(c.bold('Presets') + c.dim('  @pulpfixer/preset-<name>, applied with pf sys apply <name>'));
    for (const name of names) {
      const mine = cached.find((p) => p.name === name);
      const latest = remote.presets?.find((p) => p.name === name);
      const app = findApp(mine?.preset?.app ?? name);
      const have = mine ? `v${short(mine.version)}` : 'not fetched';
      const state = mine && !mine.preset
        ? c.red(`unusable: ${mine.problem}`)
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

interface Target {
  fetched: FetchedPreset;
  app: AppAdapter;
  state: AppState;
  settings: Record<string, unknown>;
  plan: Plan;
}

/** Fetch a preset, read the app it configures and work out the plan. Prints why when it cannot. */
function prepare(name: string, offline: boolean): Target | null {
  const c = out();
  const fetched = fetchPreset(name, { offline });
  if ('error' in fetched) {
    fail(fetched.error);
    return null;
  }
  const where = fetched.source === 'registry' ? `latest from the registry${fetched.previous ? `, was v${short(fetched.previous)}` : ''}` : 'cached copy';
  process.stdout.write(`${c.bold(`${presetPackage(name)} v${short(fetched.version)}`)} ${c.dim(`(${where})`)}\n`);
  if (fetched.note) process.stderr.write(`${badgeLabel('warning', err())} ${fetched.note}: using the cached copy\n`);
  const app = findApp(fetched.preset.app);
  if (!app) {
    fail(`this pf has no adapter for "${fetched.preset.app}" (apps: ${APPS.map((a) => a.id).join(', ')}). Run: pf update`);
    return null;
  }
  if (!app.detect()) {
    fail(`${app.label} does not seem to be installed here (looked for ${app.settingsPath()})`);
    return null;
  }
  const state = app.readState();
  if (state.settings === null) {
    for (const p of state.problems) fail(p);
    return null;
  }
  for (const p of state.problems) process.stderr.write(`${badgeLabel('warning', err())} ${p}\n`);
  const plan = planPreset(fetched.preset, { extensions: state.extensions, settings: state.settings });
  return { fetched, app, state, settings: state.settings, plan };
}

/** Write the plan's settings into the app's settings file, keeping a backup of the old one. */
function writeSettings(t: Target): { ok: true; backup: string | null } | { ok: false; error: string } {
  const file = t.state.settingsPath;
  const entries = settingsToWrite(t.plan);
  const next = setTopLevelKeys(t.state.settingsText ?? '', entries);
  const parsed = next === null ? null : parseJsonc(next);
  if (next === null || !parsed || !Object.entries(entries).every(([k, v]) => sameJson(parsed[k], v))) {
    return { ok: false, error: `could not edit ${file} safely, nothing was written` };
  }
  let backup: string | null = null;
  try {
    if (t.state.settingsText !== null) {
      backup = `${file}.pf-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, backup);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
  } catch (e) {
    return { ok: false, error: `could not write ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, backup };
}

async function applyPreset(t: Target, o: { yes: boolean; dryRun: boolean }): Promise<number> {
  const c = out();
  const r = reporter(c);
  const w = (s: string) => process.stdout.write(s + '\n');
  const { plan, app } = t;
  for (const line of describePlan(plan, c)) w(line);
  if (isEmptyPlan(plan)) {
    r.ok(`${app.label} already matches the preset`);
    return 0;
  }
  if (plan.install.length && t.state.extensions === null) r.warn('extensions are skipped: they could not be read');

  if (o.dryRun) {
    for (const id of plan.install) {
      const argv = app.installArgv(t.state, id);
      if (argv) await runCmd({ argv }, { dryRun: true });
    }
    if (plan.settings.length) r.info(`would set ${plan.settings.length} setting${plan.settings.length === 1 ? '' : 's'} in ${t.state.settingsPath} (a backup is kept)`);
    return 0;
  }

  if (!o.yes) {
    const yes = await confirm(`Apply to ${app.label}?`, false, { flag: '--yes' });
    if (!yes) {
      r.info('nothing changed');
      return interactive() ? 0 : 1;
    }
  }

  let fails = 0;
  if (plan.settings.length) {
    const res = writeSettings(t);
    if (res.ok) {
      r.ok(`set ${plan.settings.length} setting${plan.settings.length === 1 ? '' : 's'} in ${t.state.settingsPath}`);
      if (res.backup) r.info(`previous file kept as ${res.backup}`);
    } else {
      r.fail(res.error);
      fails++;
    }
  }
  for (const id of plan.install) {
    const argv = app.installArgv(t.state, id);
    if (!argv) {
      r.warn(`${id}: ${app.label} has no command line launcher, skipped`);
      fails++;
      continue;
    }
    r.step(`installing ${id}`);
    const res = await captureAsync({ argv }, { timeout: 5 * 60_000, maxBytes: 4_000 });
    const lastLine = res.output.trim().split('\n').filter(Boolean).pop() ?? '';
    if (res.code !== 0 || /not found|failed installing/i.test(res.output)) {
      r.fail(`${id}: ${lastLine || `exit ${res.code}`}`);
      fails++;
    } else r.ok(id);
  }
  w('');
  if (fails) r.fail(`${fails} step${fails === 1 ? '' : 's'} failed`);
  else r.ok(`${app.label} now matches ${presetPackage(t.fetched.name)} v${short(t.fetched.version)}`);
  return fails ? 1 : 0;
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
  usage: 'pf sys [list | diff <preset> | apply <preset> [--yes] [--dry-run] [--offline] | capture <app> [--setting <key>]]',
  async run(_ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const yes = takeFlag(rest, '--yes', '-y');
    const offline = takeFlag(rest, '--offline');
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
      const target = prepare(name, offline);
      if (!target) return 1;
      if (sub === 'diff') {
        const c = out();
        const lines = describePlan(target.plan, c);
        for (const l of lines) process.stdout.write(l + '\n');
        if (isEmptyPlan(target.plan)) process.stdout.write(`  ${c.green('✔')} ${target.app.label} already matches the preset\n`);
        return 0;
      }
      return applyPreset(target, { yes, dryRun });
    }
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
