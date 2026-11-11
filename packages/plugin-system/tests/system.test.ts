import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listExtensionsArgv, parseExtensions, settingsPathFor } from '../src/apps/editor.js';
import { findApp } from '../src/apps/index.js';
import { parseJsonc, sameJson, setTopLevelKeys } from '../src/jsonc.js';
import { capturePreset, describePlan, isEmptyPlan, planPreset, settingsToWrite } from '../src/plan.js';
import { cachedPreset, fetchPreset, installArgv, isPresetName, parseSearch, pickPresetPackages, presetOfPackage, presetPackage, validatePreset } from '../src/presets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- jsonc ----

const SETTINGS = `{
    // look
    "editor.fontSize": 13, // keep
    "files.autoSave": "afterDelay",
    /* block */
    "workbench.colorTheme": "Default Light+",
}
`;

test('parseJsonc reads comments and trailing commas, and rejects non-objects', () => {
  assert.deepEqual(parseJsonc(SETTINGS), { 'editor.fontSize': 13, 'files.autoSave': 'afterDelay', 'workbench.colorTheme': 'Default Light+' });
  assert.deepEqual(parseJsonc(''), {});
  assert.deepEqual(parseJsonc('  // nothing\n'), {});
  assert.equal(parseJsonc('[1]'), null);
  assert.equal(parseJsonc('{ "a": '), null);
  assert.deepEqual(parseJsonc('{"url": "http://x/y", "a": [1, 2,],}'), { url: 'http://x/y', a: [1, 2] });
});

test('setTopLevelKeys replaces a value in place and keeps comments and indentation', () => {
  const next = setTopLevelKeys(SETTINGS, { 'editor.fontSize': 14 })!;
  assert.equal(next, SETTINGS.replace('13', '14'));
});

test('setTopLevelKeys appends new keys with the file indentation', () => {
  const next = setTopLevelKeys(SETTINGS, { 'editor.formatOnSave': true, 'files.exclude': { '**/.git': true } })!;
  assert.ok(next.includes('// look') && next.includes('/* block */') && next.includes('// keep'));
  assert.ok(next.includes('    "editor.formatOnSave": true'));
  assert.ok(next.includes('    "files.exclude": {\n        "**/.git": true\n    }'));
  assert.deepEqual(parseJsonc(next), {
    'editor.fontSize': 13,
    'files.autoSave': 'afterDelay',
    'workbench.colorTheme': 'Default Light+',
    'editor.formatOnSave': true,
    'files.exclude': { '**/.git': true },
  });
});

test('setTopLevelKeys handles empty files, empty objects and a missing trailing comma', () => {
  assert.equal(setTopLevelKeys('', { a: 1 }), '{\n  "a": 1\n}\n');
  assert.equal(setTopLevelKeys('{}', { a: 1, b: 'x' }), '{\n  "a": 1,\n  "b": "x"\n}');
  assert.deepEqual(parseJsonc(setTopLevelKeys('{\n  "a": 1\n}', { b: 2 })!), { a: 1, b: 2 });
  assert.equal(setTopLevelKeys('{ "a": 1 }', {}), '{ "a": 1 }');
});

test('setTopLevelKeys refuses text that is not an object, and nested keys are not top-level', () => {
  assert.equal(setTopLevelKeys('[1, 2]', { a: 1 }), null);
  assert.equal(setTopLevelKeys('{ "a": ', { a: 1 }), null);
  const next = setTopLevelKeys('{\n  "outer": { "a": 1 }\n}', { a: 2 })!;
  assert.deepEqual(parseJsonc(next), { outer: { a: 1 }, a: 2 });
});

test('sameJson compares deeply', () => {
  assert.ok(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!sameJson({ a: 1 }, { a: 2 }));
  assert.ok(!sameJson([1], { 0: 1 }));
  assert.ok(!sameJson(1, '1'));
});

// ---- presets ----

test('validatePreset accepts a good preset and says what is wrong with a bad one', () => {
  const ok = validatePreset({ app: 'cursor', summary: 's', extensions: ['a.b', 'A.B', 'c.d-e'], settings: { 'x.y': 1 } });
  assert.deepEqual(ok, { app: 'cursor', summary: 's', extensions: ['a.b', 'c.d-e'], settings: { 'x.y': 1 } });
  assert.deepEqual(validatePreset({ app: 'cursor' }), { app: 'cursor', summary: '', extensions: [], settings: {} });
  assert.equal(typeof validatePreset(null), 'string');
  assert.equal(typeof validatePreset({}), 'string');
  assert.match(validatePreset({ app: 'cursor', extensions: ['nodot'] }) as string, /not an extension id/);
  assert.match(validatePreset({ app: 'cursor', extensions: 'a.b' }) as string, /array/);
  assert.match(validatePreset({ app: 'cursor', settings: [] }) as string, /object/);
  assert.equal(typeof validatePreset({ app: 'Cursor App' }), 'string');
});

test('the Cursor preset package is valid, ready to publish and has an adapter', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, '..', 'preset-cursor', 'package.json'), 'utf8')) as { name: string; files: string[] };
  assert.equal(pkg.name, presetPackage('cursor'));
  assert.deepEqual(pkg.files, ['preset.json']);
  const preset = validatePreset(JSON.parse(fs.readFileSync(path.join(root, '..', 'preset-cursor', 'preset.json'), 'utf8')));
  assert.equal(typeof preset, 'object');
  if (typeof preset === 'string') return;
  assert.equal(preset.app, 'cursor');
  assert.ok(preset.extensions.length > 0);
  assert.ok(findApp(preset.app));
});

test('preset names and packages', () => {
  assert.ok(isPresetName('cursor') && isPresetName('vs-code'));
  assert.ok(!isPresetName('Cursor') && !isPresetName('../x') && !isPresetName(''));
  assert.equal(presetPackage('cursor'), '@pulpfixer/preset-cursor');
  assert.equal(presetOfPackage('@pulpfixer/preset-cursor'), 'cursor');
  assert.equal(presetOfPackage('@pulpfixer/plugin-aws'), null);
  assert.equal(presetOfPackage('@pf-plugins/preset-x'), null);
});

test('search results keep only preset packages', () => {
  const found = pickPresetPackages(
    parseSearch('npm notice something\n' + JSON.stringify([{ name: '@pulpfixer/preset-cursor', version: '1.2.0', description: 'd' }, { name: '@pulpfixer/kit', version: '1.0.0' }, { name: '@pulpfixer/preset-a', version: '1.0.0' }])),
  );
  assert.deepEqual(found.map((p) => p.name), ['a', 'cursor']);
  assert.deepEqual(parseSearch('nothing'), []);
});

test('installArgv installs the latest preset into the pf presets prefix', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sys-'));
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = home;
  try {
    const argv = installArgv(presetPackage('cursor'));
    assert.equal(argv[2], '@pulpfixer/preset-cursor@latest');
    assert.equal(argv[argv.indexOf('--prefix') + 1], path.join(home, 'sys', 'presets'));
    assert.ok(argv.includes('--registry'));
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('fetchPreset --offline uses the cached copy, and says so when there is none', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sys-'));
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = home;
  try {
    assert.match((fetchPreset('cursor', { offline: true }) as { error: string }).error, /not cached yet/);
    assert.match((fetchPreset('../x') as { error: string }).error, /not a preset name/);
    assert.equal(cachedPreset('cursor'), null);

    const dir = path.join(home, 'sys', 'presets', 'node_modules', '@pulpfixer', 'preset-cursor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@pulpfixer/preset-cursor', version: '1.3.0' }));
    fs.writeFileSync(path.join(dir, 'preset.json'), JSON.stringify({ app: 'cursor', extensions: ['a.b'] }));
    const got = fetchPreset('cursor', { offline: true });
    assert.ok(!('error' in got));
    if ('error' in got) return;
    assert.equal(got.version, '1.3.0');
    assert.equal(got.source, 'cache');
    assert.deepEqual(got.preset.extensions, ['a.b']);

    fs.writeFileSync(path.join(dir, 'preset.json'), '{ nope');
    assert.match((fetchPreset('cursor', { offline: true }) as { error: string }).error, /unusable/);
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- apps ----

test('settings.json lives in the platform config dir', () => {
  const spec = { configDir: 'Cursor' };
  assert.equal(settingsPathFor(spec, 'darwin', {}, '/Users/x'), '/Users/x/Library/Application Support/Cursor/User/settings.json');
  assert.equal(settingsPathFor(spec, 'linux', {}, '/home/x'), '/home/x/.config/Cursor/User/settings.json');
  assert.equal(settingsPathFor(spec, 'linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/x'), '/cfg/Cursor/User/settings.json');
  assert.equal(settingsPathFor(spec, 'win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x'), path.join('C:\\Users\\x\\AppData\\Roaming', 'Cursor', 'User', 'settings.json'));
});

test('parseExtensions keeps ids and drops the editor log noise', () => {
  const stdout = '[1110/164529.094594:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid\nanthropic.claude-code\n  esbenp.prettier-vscode  \n\nms-python.debugpy\n{ errno: -1 }\n';
  assert.deepEqual(parseExtensions(stdout), ['anthropic.claude-code', 'esbenp.prettier-vscode', 'ms-python.debugpy']);
  assert.deepEqual(listExtensionsArgv('/x/cursor'), ['/x/cursor', '--list-extensions']);
});

test('the cursor adapter installs through the cursor launcher', () => {
  const app = findApp('cursor')!;
  const state = { cli: '/x/cursor', extensions: [], settingsPath: '', settingsText: null, settings: {}, problems: [] };
  assert.deepEqual(app.installArgv(state, 'a.b'), ['/x/cursor', '--install-extension', 'a.b']);
  assert.equal(app.installArgv({ ...state, cli: null }, 'a.b'), null);
  assert.equal(findApp('nope'), undefined);
});

// ---- plan ----

const preset = { app: 'cursor', summary: '', extensions: ['A.One', 'b.two', 'c.three'], settings: { 'editor.formatOnSave': true, 'editor.fontSize': 14, 'files.exclude': { x: 1 } } };

test('planPreset installs what is missing and sets what differs, leaving the rest alone', () => {
  const plan = planPreset(preset, { extensions: ['a.one', 'z.other'], settings: { 'editor.fontSize': 13, 'files.exclude': { x: 1 }, 'unrelated': 1 } });
  assert.deepEqual(plan.install, ['b.two', 'c.three']);
  assert.deepEqual(plan.settings, [
    { key: 'editor.formatOnSave', from: undefined, to: true },
    { key: 'editor.fontSize', from: 13, to: 14 },
  ]);
  assert.equal(plan.extensionsOk, 1);
  assert.equal(plan.settingsOk, 1);
  assert.deepEqual(settingsToWrite(plan), { 'editor.formatOnSave': true, 'editor.fontSize': 14 });
  assert.ok(!isEmptyPlan(plan));
});

test('planPreset is empty when the app already matches, and plans no installs when extensions are unreadable', () => {
  const match = planPreset(preset, { extensions: ['a.one', 'b.two', 'c.three'], settings: { 'editor.formatOnSave': true, 'editor.fontSize': 14, 'files.exclude': { x: 1 } } });
  assert.ok(isEmptyPlan(match));
  const unknown = planPreset(preset, { extensions: null, settings: {} });
  assert.deepEqual(unknown.install, []);
  assert.equal(unknown.settings.length, 3);
});

test('a prototype key is not mistaken for a set setting', () => {
  const plan = planPreset({ ...preset, extensions: [], settings: { toString: 1 } }, { extensions: [], settings: {} });
  assert.deepEqual(plan.settings, [{ key: 'toString', from: undefined, to: 1 }]);
});

test('describePlan lists installs and changes in plain text without a palette', () => {
  const c = { on: false, bold: (s: string) => s, dim: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s } as never;
  const lines = describePlan(planPreset(preset, { extensions: ['a.one'], settings: { 'editor.fontSize': 13 } }), c);
  assert.ok(lines.includes('Extensions to install (2)'));
  assert.ok(lines.includes('  + b.two'));
  assert.ok(lines.includes('  ~ editor.fontSize: 13 -> 14'));
  assert.ok(lines.includes('  + editor.formatOnSave: true'));
  assert.ok(lines.some((l) => l.startsWith('already in place: 1 extension')));
});

test('capturePreset builds a sorted preset and reports settings that are not set', () => {
  const { preset: p, missing } = capturePreset('cursor', 'Cursor', { extensions: ['b.two', 'A.one'], settings: { 'editor.fontSize': 13 } }, ['editor.fontSize', 'nope']);
  assert.deepEqual(p, { app: 'cursor', summary: 'Standard Cursor setup', extensions: ['A.one', 'b.two'], settings: { 'editor.fontSize': 13 } });
  assert.deepEqual(missing, ['nope']);
  assert.equal(typeof validatePreset(JSON.parse(JSON.stringify(p))), 'object');
});
