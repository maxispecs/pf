import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { suiteCommand } from '../src/commands/suite.js';
import { applyObsidian, backupDir } from '../src/obsidian/apply.js';
import { validateObsidianConfig, type ObsidianConfig } from '../src/obsidian/config.js';
import { applyChanges, diffObject, isEmptyObsidianPlan, planObsidian, readVault } from '../src/obsidian/plan.js';
import { listVaults, obsidianConfigDir, parseVaultList, resolveVault } from '../src/obsidian/vaults.js';
import { validatePreset } from '../src/presets.js';
import { enableFeatures, featureStatuses } from '../src/suite.js';
import { featureOf, validateSuite, type Suite } from '../src/suitefile.js';
import { readSuiteState, recordEnabled } from '../src/suitestate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `pf-${name}-`));
const write = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};
const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Run with PF_HOME and PF_OBSIDIAN_DIR pointing at temp folders. */
async function sandbox<T>(fn: (dirs: { home: string; obsidian: string }) => Promise<T> | T): Promise<T> {
  const home = tmp('home');
  const obsidian = tmp('obs');
  const prev = { h: process.env.PF_HOME, o: process.env.PF_OBSIDIAN_DIR };
  process.env.PF_HOME = home;
  process.env.PF_OBSIDIAN_DIR = obsidian;
  try {
    return await fn({ home, obsidian });
  } finally {
    if (prev.h === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev.h;
    if (prev.o === undefined) delete process.env.PF_OBSIDIAN_DIR;
    else process.env.PF_OBSIDIAN_DIR = prev.o;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(obsidian, { recursive: true, force: true });
  }
}

const cache = (home: string, pkg: string, version: string, files: Record<string, unknown>): void => {
  const dir = path.join(home, 'sys', 'presets', 'node_modules', ...pkg.split('/'));
  write(path.join(dir, 'package.json'), { name: pkg, version });
  for (const [name, content] of Object.entries(files)) write(path.join(dir, name), content);
};

const SUITE: Suite = {
  summary: '',
  features: [
    { id: 'cursor', summary: 'c', preset: 'cursor', packages: ['@pulpfixer/ext-bg-tone'], optional: false },
    { id: 'obsidian', summary: 'o', preset: 'obsidian', packages: [], optional: true },
  ],
};

// ---- the suite file ----

test('validateSuite reads features and refuses bad ones', () => {
  const ok = validateSuite({ features: [{ id: 'a', preset: 'a-b', optional: true, packages: ['@pulpfixer/ext-x', '@pulpfixer/ext-x'] }, { id: 'b', preset: 'b' }] }) as Suite;
  assert.deepEqual(ok.features.map((f) => [f.id, f.optional, f.packages]), [['a', true, ['@pulpfixer/ext-x']], ['b', false, []]]);
  assert.match(validateSuite({}) as string, /features/);
  assert.match(validateSuite({ features: [{ id: 'A b', preset: 'a' }] }) as string, /feature id/);
  assert.match(validateSuite({ features: [{ id: 'a', preset: 'a' }, { id: 'a', preset: 'a' }] }) as string, /twice/);
  assert.match(validateSuite({ features: [{ id: 'a', preset: '../x' }] }) as string, /preset/);
  assert.match(validateSuite({ features: [{ id: 'a', preset: 'a', packages: ['left-pad'] }] }) as string, /not an extension package/);
  assert.match(validateSuite({ features: [{ id: 'a', preset: 'a', optional: 'yes' }] }) as string, /optional/);
  assert.equal(featureOf(SUITE, 'obsidian')?.optional, true);
});

test('suite state records what was applied and survives a corrupt file', async () => {
  await sandbox(({ home }) => {
    assert.deepEqual(readSuiteState(), { features: {} });
    assert.equal(recordEnabled('obsidian', '/v/one', '1.0.0', new Date('2026-01-01T00:00:00Z')), null);
    assert.equal(recordEnabled('obsidian', '/v/two', '1.1.0'), null);
    assert.equal(recordEnabled('obsidian', '/v/two', '1.1.0'), null);
    const s = readSuiteState().features.obsidian!;
    assert.deepEqual([s.targets, s.version], [['/v/one', '/v/two'], '1.1.0']);
    fs.writeFileSync(path.join(home, 'sys', 'suite-state.json'), '{nope');
    assert.deepEqual(readSuiteState(), { features: {} });
  });
});

// ---- the obsidian preset ----

test('the shipped obsidian preset validates and holds only data', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, '..', 'preset-obsidian', 'preset.json'), 'utf8'));
  const preset = validatePreset(raw);
  assert.equal(typeof preset, 'object');
  const cfg = (preset as { obsidian: ObsidianConfig }).obsidian;
  assert.equal(cfg.appearance.cssTheme, 'Minimal');
  assert.equal(cfg.communityPlugins.length, 8);
  assert.equal(cfg.corePlugins.canvas, true);
  // per-vault and personal values stay out of the shared preset
  const text = JSON.stringify(cfg);
  for (const personal of ['vaultTitle', 'exportPath', 'recentlyUsedIcons', 'CRI/']) assert.ok(!text.includes(personal), personal);
  assert.ok(!('sync' in cfg.corePlugins));
});

test('validateObsidianConfig refuses unknown sections, bad ids and path-like names', () => {
  assert.match(validateObsidianConfig({ scripts: {} }) as string, /not a known section/);
  assert.match(validateObsidianConfig({ communityPlugins: ['../evil'] }) as string, /not a community plugin id/);
  assert.match(validateObsidianConfig({ corePlugins: { 'a/b': true } }) as string, /not a core plugin id/);
  assert.match(validateObsidianConfig({ corePlugins: { canvas: 'yes' } }) as string, /true or false/);
  assert.match(validateObsidianConfig({ appearance: { cssTheme: '../x' } }) as string, /theme name/);
  assert.match(validateObsidianConfig({ pluginSettings: { 'Bad Id': {} } }) as string, /not a plugin id/);
  assert.match(validateObsidianConfig({ pluginSettings: { ok: JSON.parse('{"__proto__": {"x": 1}}') } }) as string, /not a settings key/);
  assert.match(validateObsidianConfig({ hotkeys: { nocolon: [] } }) as string, /command id/);
  assert.match(validateObsidianConfig({ hotkeys: { 'a:b': [{ modifiers: ['Hyper'], key: 'x' }] } }) as string, /modifiers/);
  assert.equal(typeof validateObsidianConfig({ hotkeys: { 'a:b': [{ modifiers: ['Mod'], key: 'J' }] } }), 'object');
  assert.match(validatePreset({ app: 'cursor', obsidian: {} }) as string, /belongs to a preset/);
  assert.match(validatePreset({ app: 'obsidian' }) as string, /needs an "obsidian" section/);
});

// ---- vaults ----

test('obsidianConfigDir follows the platform and PF_OBSIDIAN_DIR', () => {
  assert.equal(obsidianConfigDir('darwin', {}, '/h'), '/h/Library/Application Support/obsidian');
  assert.equal(obsidianConfigDir('linux', {}, '/h'), '/h/.config/obsidian');
  assert.equal(obsidianConfigDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h'), '/x/obsidian');
  assert.equal(obsidianConfigDir('win32', { APPDATA: 'C:\\A' }, 'C:\\h'), path.join('C:\\A', 'obsidian'));
  assert.equal(obsidianConfigDir('darwin', { PF_OBSIDIAN_DIR: '/o' }, '/h'), '/o');
});

test('parseVaultList and listVaults read obsidian.json, with stale paths marked', async () => {
  assert.equal(parseVaultList('nope'), null);
  assert.equal(parseVaultList('{"vaults": []}'), null);
  assert.deepEqual(parseVaultList('{"vaults":{"a":{"path":"/x/A","open":true},"b":{"path":"rel"},"c":{}}}'), [{ id: 'a', path: '/x/A', open: true }]);
  await sandbox(({ obsidian }) => {
    assert.equal(listVaults().found, false);
    const good = tmp('vault');
    fs.mkdirSync(path.join(good, '.obsidian'));
    write(path.join(obsidian, 'obsidian.json'), { vaults: { g: { path: good }, gone: { path: '/definitely/not/here' } } });
    const list = listVaults();
    assert.deepEqual(list.vaults.map((v) => [v.id, v.exists, v.configured]), [['g', true, true], ['gone', false, false]]);
    fs.rmSync(good, { recursive: true, force: true });
  });
});

test('resolveVault takes a path or a known vault name and checks the folder', () => {
  const base = tmp('vaults');
  const a = path.join(base, 'Alpha');
  const plain = path.join(base, 'Plain');
  fs.mkdirSync(path.join(a, '.obsidian'), { recursive: true });
  fs.mkdirSync(plain);
  const known = [{ id: '1', path: a, open: false, exists: true, configured: true }];
  const real = fs.realpathSync(a);
  assert.deepEqual(resolveVault(a, known), { path: real });
  assert.deepEqual(resolveVault('alpha', known), { path: real });
  assert.match(resolveVault(plain, known) as string, /no \.obsidian folder/);
  assert.match(resolveVault(path.join(base, 'missing'), known) as string, /not a folder/);
  assert.match(resolveVault('  ', known) as string, /needs a path/);
  assert.match(resolveVault('Dup', [...known, { ...known[0]!, id: '2', path: path.join(base, 'x', 'dup') }, { ...known[0]!, id: '3', path: path.join(base, 'y', 'Dup') }]) as string, /more than one vault/);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---- the plan ----

const CFG: ObsidianConfig = validateObsidianConfig({
  app: { promptDelete: false, newLinkFormat: 'absolute' },
  appearance: { cssTheme: 'Minimal', showRibbon: true },
  corePlugins: { canvas: true, sync: false },
  communityPlugins: ['have-it', 'not-here'],
  hotkeys: { 'have-it:go': [{ modifiers: ['Mod'], key: 'J' }] },
  pluginSettings: { 'have-it': { a: 1, nested: { x: 1, y: 2 } }, 'not-here': { b: 1 }, 'ghost-only': { c: 1 } },
}) as ObsidianConfig;

function makeVault(): string {
  const v = tmp('vault');
  const o = path.join(v, '.obsidian');
  write(path.join(o, 'app.json'), { promptDelete: true, readableLineLength: false });
  write(path.join(o, 'core-plugins.json'), { canvas: false, graph: true });
  write(path.join(o, 'community-plugins.json'), ['other']);
  write(path.join(o, 'plugins', 'have-it', 'manifest.json'), { id: 'have-it' });
  write(path.join(o, 'plugins', 'have-it', 'data.json'), { keep: 'me', nested: { x: 0, z: 3 } });
  return v;
}

test('diffObject is leaf-wise and applyChanges keeps other keys', () => {
  const cur = { keep: 1, nested: { x: 0, z: 3 }, same: 'v' };
  const d = diffObject(cur, { nested: { x: 1, y: 2 }, same: 'v', fresh: { deep: true } });
  assert.equal(d.ok, 1);
  assert.deepEqual(d.changes.map((c) => c.path.join('.')), ['nested.x', 'nested.y', 'fresh']);
  assert.deepEqual(applyChanges(cur, d.changes), { keep: 1, nested: { x: 1, z: 3, y: 2 }, same: 'v', fresh: { deep: true } });
  assert.deepEqual(cur, { keep: 1, nested: { x: 0, z: 3 }, same: 'v' }, 'the input is not changed');
});

test('planObsidian is additive and reports what the vault lacks instead of installing it', () => {
  const v = makeVault();
  const plan = planObsidian(CFG, readVault(v, CFG));
  const by = Object.fromEntries(plan.files.map((f) => [f.file, f]));
  assert.deepEqual(Object.keys(by).sort(), ['app.json', 'appearance.json', 'community-plugins.json', 'core-plugins.json', 'hotkeys.json', 'plugins/have-it/data.json']);
  assert.deepEqual(by['app.json']!.next, { promptDelete: false, readableLineLength: false, newLinkFormat: 'absolute' });
  assert.deepEqual(by['core-plugins.json']!.next, { canvas: true, graph: true, sync: false });
  assert.deepEqual(by['community-plugins.json']!.next, ['other', 'have-it'], 'the list only grows, and only with installed plugins');
  assert.deepEqual(by['plugins/have-it/data.json']!.next, { keep: 'me', a: 1, nested: { x: 1, z: 3, y: 2 } });
  assert.equal(by['appearance.json']!.isNew, true);
  assert.deepEqual(by['appearance.json']!.next, { showRibbon: true }, 'the theme is not set while it is not installed');
  assert.deepEqual(plan.missingPlugins.sort(), ['ghost-only', 'not-here']);
  assert.equal(plan.missingTheme, 'Minimal');

  write(path.join(v, '.obsidian', 'themes', 'Minimal', 'theme.css'), '/* css */');
  const withTheme = planObsidian(CFG, readVault(v, CFG));
  assert.deepEqual(withTheme.files.find((f) => f.file === 'appearance.json')!.next, { cssTheme: 'Minimal', showRibbon: true });
  assert.equal(withTheme.missingTheme, null);
  fs.rmSync(v, { recursive: true, force: true });
});

test('readVault refuses a file that is not what Obsidian writes', () => {
  const v = makeVault();
  write(path.join(v, '.obsidian', 'app.json'), '{broken');
  write(path.join(v, '.obsidian', 'community-plugins.json'), '{"a": 1}');
  const state = readVault(v, CFG);
  assert.equal(state.problems.length, 2);
  assert.match(state.problems.join('\n'), /app\.json is not valid JSON/);
  assert.match(state.problems.join('\n'), /community-plugins\.json is not a JSON array/);
  fs.rmSync(v, { recursive: true, force: true });
});

// ---- applying ----

test('applyObsidian: dry run writes nothing, apply backs up and writes, a second run is a no-op', async () => {
  await sandbox(async ({ home }) => {
    const v = makeVault();
    const app = path.join(v, '.obsidian', 'app.json');
    const before = fs.readFileSync(app, 'utf8');
    const never = () => false;

    const dry = await applyObsidian(CFG, v, { yes: true, dryRun: true, running: never });
    assert.deepEqual(dry, { code: 0, applied: false });
    assert.equal(fs.readFileSync(app, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(home, 'sys', 'backups')));

    const run = await applyObsidian(CFG, v, { yes: true, dryRun: false, running: never });
    assert.deepEqual(run, { code: 0, applied: true });
    assert.deepEqual(read(app), { promptDelete: false, readableLineLength: false, newLinkFormat: 'absolute' });
    assert.deepEqual(read(path.join(v, '.obsidian', 'community-plugins.json')), ['other', 'have-it']);
    const slugs = fs.readdirSync(path.join(home, 'sys', 'backups', 'obsidian'));
    assert.equal(slugs.length, 1);
    const stamps = fs.readdirSync(path.join(home, 'sys', 'backups', 'obsidian', slugs[0]!));
    const saved = path.join(home, 'sys', 'backups', 'obsidian', slugs[0]!, stamps[0]!, 'app.json');
    assert.equal(fs.readFileSync(saved, 'utf8'), before);
    assert.ok(!fs.readdirSync(path.join(v, '.obsidian')).some((f) => f.includes('pf-tmp')), 'no temp file is left behind');

    const plan = planObsidian(CFG, readVault(v, CFG));
    assert.equal(isEmptyObsidianPlan(plan), true);
    const again = await applyObsidian(CFG, v, { yes: true, dryRun: false, running: never });
    assert.deepEqual(again, { code: 0, applied: true });
    fs.rmSync(v, { recursive: true, force: true });
  });
});

test('applyObsidian refuses a broken file and without --yes and a terminal changes nothing', async () => {
  await sandbox(async () => {
    const v = makeVault();
    write(path.join(v, '.obsidian', 'hotkeys.json'), '[1,2]');
    assert.deepEqual(await applyObsidian(CFG, v, { yes: true, dryRun: false, running: () => false }), { code: 1, applied: false });
    write(path.join(v, '.obsidian', 'hotkeys.json'), '{}');
    const app = path.join(v, '.obsidian', 'app.json');
    const before = fs.readFileSync(app, 'utf8');
    assert.deepEqual(await applyObsidian(CFG, v, { yes: false, dryRun: false, running: () => false }), { code: 1, applied: false });
    assert.equal(fs.readFileSync(app, 'utf8'), before);
    fs.rmSync(v, { recursive: true, force: true });
  });
});

test('backupDir is stable per vault and does not sit in the vault', async () => {
  await sandbox(({ home }) => {
    const a = backupDir('/v/CRI', new Date('2026-01-02T03:04:05.678Z'));
    assert.ok(a.startsWith(path.join(home, 'sys', 'backups', 'obsidian', 'CRI-')));
    assert.ok(a.endsWith('2026-01-02T03-04-05-678Z'));
    assert.notEqual(path.dirname(a), path.dirname(backupDir('/other/CRI', new Date())));
  });
});

// ---- pf suite ----

test('pf suite enable: unknown feature is a usage error, a bare enable skips the optional ones', async () => {
  await sandbox(async ({ home }) => {
    cache(home, '@pulpfixer/suite', '1.0.0', { 'suite.json': SUITE });
    assert.equal(await enableFeatures(['nope'], { offline: true }), 2);
    // only an optional feature in the suite: nothing is a default, so a bare enable has nothing to do
    cache(home, '@pulpfixer/suite', '1.0.1', { 'suite.json': { features: [SUITE.features[1]] } });
    assert.equal(await enableFeatures([], { offline: true }), 1);
  });
});

test('pf suite enable obsidian: no vault and no terminal is exit 2; --vault applies; a bad --vault is exit 2', async () => {
  await sandbox(async ({ home, obsidian }) => {
    cache(home, '@pulpfixer/suite', '1.0.0', { 'suite.json': SUITE });
    cache(home, '@pulpfixer/preset-obsidian', '1.2.0', { 'preset.json': JSON.parse(fs.readFileSync(path.join(root, '..', 'preset-obsidian', 'preset.json'), 'utf8')) });
    const v = tmp('vault');
    fs.mkdirSync(path.join(v, '.obsidian'));
    write(path.join(obsidian, 'obsidian.json'), { vaults: { x: { path: v } } });

    assert.equal(await enableFeatures(['obsidian'], { offline: true, yes: true }), 2, 'which vault?');
    assert.equal(await enableFeatures(['obsidian'], { offline: true, yes: true, vault: path.join(v, 'missing') }), 2);
    assert.equal(readSuiteState().features.obsidian, undefined);

    assert.equal(await enableFeatures(['obsidian'], { offline: true, yes: true, dryRun: true, vault: v }), 0);
    assert.equal(fs.existsSync(path.join(v, '.obsidian', 'core-plugins.json')), false, 'a dry run writes nothing');
    assert.equal(readSuiteState().features.obsidian, undefined, 'and records nothing');

    assert.equal(await enableFeatures(['obsidian'], { offline: true, yes: true, vault: path.basename(v) }), 0, 'a known vault by name');
    assert.equal((read(path.join(v, '.obsidian', 'core-plugins.json')) as Record<string, boolean>).canvas, true);
    assert.deepEqual(readSuiteState().features.obsidian!.targets, [fs.realpathSync(v)]);
    assert.equal(readSuiteState().features.obsidian!.version, '1.2.0');

    const status = featureStatuses(SUITE).find((s) => s.feature.id === 'obsidian')!;
    assert.equal(status.state, 'on');
    fs.rmSync(v, { recursive: true, force: true });
  });
});

test('featureStatuses: Obsidian is n/a when it was never run, off until a vault was configured', async () => {
  await sandbox(({ obsidian }) => {
    fs.rmSync(obsidian, { recursive: true, force: true });
    const missing = featureStatuses({ summary: '', features: [SUITE.features[1]!] })[0]!;
    assert.equal(missing.state, 'unavailable');
    fs.mkdirSync(obsidian);
    assert.equal(featureStatuses({ summary: '', features: [SUITE.features[1]!] })[0]!.state, 'off');
  });
});

test('pf suite argument handling', async () => {
  const ctx = {} as never;
  assert.equal(await suiteCommand.run(ctx, ['bogus']), 2);
  assert.equal(await suiteCommand.run(ctx, ['list', '--nope']), 2);
  assert.equal(await suiteCommand.run(ctx, ['enable', '--vault']), 2);
  await sandbox(async ({ home }) => {
    cache(home, '@pulpfixer/suite', '1.0.0', { 'suite.json': SUITE });
    assert.equal(await suiteCommand.run(ctx, ['enable', 'nope', '--offline']), 2);
    assert.equal(await suiteCommand.run(ctx, ['list', '--offline', '--json']), 0);
  });
});

// ---- pf suite config ----

/** Run a suite command and return its exit code and what it wrote to stdout. */
async function runSuite(args: string[]): Promise<{ code: number; stdout: string }> {
  const real = process.stdout.write.bind(process.stdout);
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await suiteCommand.run({} as never, args);
    return { code, stdout };
  } finally {
    process.stdout.write = real;
  }
}

test('pf suite config: show, set, get, unset round-trip', async () => {
  const prev = process.env.PF_REPOS_DIR;
  delete process.env.PF_REPOS_DIR;
  try {
    await sandbox(async ({ home }) => {
      const shown = await runSuite(['config', '--json']);
      assert.equal(shown.code, 0);
      const json = JSON.parse(shown.stdout) as { file: string; settings: { key: string; value: string; source: string }[] };
      assert.deepEqual(json.settings.map((s) => [s.key, s.value, s.source]), [['reposDir', '~/dev', 'default']]);
      assert.equal(json.file, path.join(home, 'config.json'));

      assert.equal((await runSuite(['config'])).code, 0);

      const target = path.join(home, 'repos');
      assert.equal((await runSuite(['config', 'set', 'reposDir', target])).code, 0);
      assert.equal(fs.existsSync(target), false, 'set does not create the folder');
      assert.equal((await runSuite(['config', 'get', 'reposDir'])).stdout, target + '\n');
      assert.equal((await runSuite(['config', 'set', 'reposDir', '~/code'])).code, 0);
      assert.equal((await runSuite(['config', 'get', 'reposDir'])).stdout, path.join(os.homedir(), 'code') + '\n');

      assert.equal((await runSuite(['config', 'unset', 'reposDir'])).code, 0);
      assert.equal((await runSuite(['config', 'get', 'reposDir'])).stdout, path.join(os.homedir(), 'dev') + '\n');
    });
  } finally {
    if (prev !== undefined) process.env.PF_REPOS_DIR = prev;
  }
});

test('pf suite config: usage errors are exit 2, a failed save is exit 1', async () => {
  await sandbox(async ({ home }) => {
    for (const args of [
      ['config', 'bogus'],
      ['config', 'get'],
      ['config', 'get', 'nope'],
      ['config', 'set', 'nope', 'x'],
      ['config', 'unset', 'nope'],
      ['config', 'set', 'reposDir', 'relative/dir'],
      ['config', 'get', 'reposDir', 'extra'],
      ['config', 'set', 'reposDir'], // no value and no terminal
    ]) {
      assert.equal((await runSuite(args)).code, 2, args.join(' '));
    }
    // a pf home that cannot be written
    const blocker = path.join(home, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const prev = process.env.PF_HOME;
    process.env.PF_HOME = path.join(blocker, 'inside');
    try {
      assert.equal((await runSuite(['config', 'set', 'reposDir', '/tmp/x'])).code, 1);
    } finally {
      process.env.PF_HOME = prev;
    }
  });
});

test('pf suite list mentions where new repos go', async () => {
  await sandbox(async ({ home }) => {
    cache(home, '@pulpfixer/suite', '1.0.0', { 'suite.json': SUITE });
    const r = await runSuite(['list', '--offline']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /new repos go in/);
    assert.match(r.stdout, /pf suite config/);
  });
});
