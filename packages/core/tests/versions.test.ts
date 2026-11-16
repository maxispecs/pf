import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SystemVersions } from '@pulpfixer/plugin-system';
import { allCommands } from '../src/commands/index.js';
import { SHORTCUTS } from '../src/commands/shortcuts.js';
import { bundledPackageVersion, bundledSection, pathSection, skillsSection, systemSections, versionLines } from '../src/commands/versions.js';
import { mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
const plain = { on: false, bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s, green: (s: string) => s } as never;

function pf(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const skill = (name: string, version?: string) =>
  `---\nname: ${name}\ndescription: A skill.\n${version ? `metadata:\n  version: "${version}"\n` : ''}---\n`;

test('pf vs is a shortcut for pf versions', () => {
  assert.ok(allCommands().some((c) => c.name === 'versions'));
  assert.ok(SHORTCUTS.some((s) => s.names.includes('vs') && s.target.join(' ') === 'versions'));
  assert.ok(allCommands().some((c) => c.name === 'vs'));
});

test('bundled packages report the versions they ship with', () => {
  assert.match(bundledPackageVersion('@pulpfixer/kit', '@pulpfixer/kit/version'), /^\d+\.\d+/);
  assert.equal(bundledPackageVersion('@pulpfixer/kit', 'node:fs'), '');
  const rows = bundledSection().rows.map((r) => r.name);
  assert.deepEqual(rows, ['@pulpfixer/kit', '@pulpfixer/plugin-aws', '@pulpfixer/plugin-yubikey', '@pulpfixer/plugin-system']);
});

test('a legacy pf on PATH is flagged and a shadowed one is a warning', () => {
  const s = pathSection([
    { path: '/a/pf', real: '/a/pf', version: '1.9.0', legacy: true },
    { path: '/b/pf', real: '/b/pf', version: '5.12.0', legacy: false },
  ]);
  assert.deepEqual(s.rows.map((r) => r.state), ['bad', 'warn']);
  assert.match(s.rows[0]!.note, /legacy/);
  assert.match(s.rows[1]!.note, /shadowed/);
  assert.equal(pathSection([]).rows.length, 0);
});

test('skills: registry installs, pf folder and bundled ones, each with a version', () => {
  const home = mkRepo({
    '.pf-home/skills/ver/SKILL.md': skill('ver'),
    '.pf-home/skills/ver/package.json': JSON.stringify({ name: '@pf-skills/ver', version: '1.7.0' }),
    '.pf-home/skills/mine/SKILL.md': skill('mine', '0.3.0'),
    '.claude/skills/save/SKILL.md': skill('save'),
    '.claude/skills/save/package.json': JSON.stringify({ name: '@pf-skills/save', version: '2.0.0' }),
    '.claude/skills/other/SKILL.md': skill('other'),
  });
  const bundled = mkRepo({ 'ver/SKILL.md': skill('ver', '1.0.0'), 'agent/SKILL.md': skill('agent', '1.2.0') });
  const prevHome = process.env.PF_HOME;
  process.env.PF_HOME = path.join(home, '.pf-home');
  try {
    const rows = skillsSection(home, bundled, path.join(home, '.pf-home', 'skills')).rows;
    const by = (name: string) => rows.filter((r) => r.name === name);
    assert.deepEqual(by('ver').map((r) => [r.version, r.note]), [
      ['1.7.0', '~/.pf/skills, registry'],
      ['1.0.0', 'bundled with pf (~/.pf/skills copy is used)'],
    ]);
    assert.deepEqual(by('save').map((r) => [r.version, r.note]), [['2.0.0', '~/.claude/skills, registry']]);
    assert.deepEqual(by('mine').map((r) => [r.version, r.note]), [['0.3.0', '~/.pf/skills, local folder']]);
    assert.deepEqual(by('agent').map((r) => [r.version, r.note]), [['1.2.0', 'bundled with pf']]);
    assert.equal(by('other').length, 0, 'a skill that did not come from the registry in an agent folder is not ours');
    const names = rows.map((r) => r.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  } finally {
    if (prevHome === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prevHome;
  }
});

const sys = (over: Partial<SystemVersions> = {}): SystemVersions => ({
  presets: [{ name: 'cursor', package: '@pulpfixer/preset-cursor', version: '1.4.0' }],
  extensions: [{ package: '@pulpfixer/ext-bg-tone', version: '2.0.0', id: 'local.bg-tone', installed: '1.0.0' }],
  app: { label: 'Cursor', found: true, readable: true },
  ...over,
});

test('suite extensions: current, outdated, missing and no app', () => {
  const ext = (s: SystemVersions) => systemSections(s)[1]!.rows[0]!;
  assert.deepEqual([ext(sys()).version, ext(sys()).state, ext(sys()).note], ['1.0.0', 'warn', 'local.bg-tone, v2.0 fetched: pf update']);
  const current = sys({ extensions: [{ package: '@pulpfixer/ext-bg-tone', version: '2.0.0', id: 'local.bg-tone', installed: '2.0.0' }] });
  assert.deepEqual([ext(current).version, ext(current).state], ['2.0.0', 'ok']);
  const missing = sys({ extensions: [{ package: '@pulpfixer/ext-bg-tone', version: '2.0.0', id: 'local.bg-tone', installed: null }] });
  assert.equal(ext(missing).state, 'warn');
  assert.match(ext(missing).note, /pf sys apply suite/);
  const noApp = sys({ app: { label: 'Cursor', found: false, readable: false } });
  assert.deepEqual([ext(noApp).version, ext(noApp).state], ['2.0.0', 'ok']);
  assert.match(ext(noApp).note, /Cursor not found/);
  const broken = sys({ extensions: [{ package: '@pulpfixer/ext-x', version: '1.0.0', id: null, installed: null, problem: 'no vsix' }] });
  assert.equal(ext(broken).state, 'bad');
  assert.equal(systemSections(sys())[0]!.rows[0]!.name, 'cursor');
});

test('versionLines aligns columns per section, shows none for an empty one and short versions', () => {
  const lines = versionLines(
    [
      { id: 'plugins', title: 'Plugins', hint: 'dir', empty: 'none yet', rows: [] },
      {
        id: 'skills',
        title: 'Skills',
        hint: '',
        empty: '',
        rows: [
          { name: 'a', version: '1.4.0', note: 'x', state: 'ok' },
          { name: 'longer', version: '', note: 'y', state: 'ok' },
        ],
      },
    ],
    plain,
  );
  assert.deepEqual(lines, ['Plugins  dir', '  none yet', '', 'Skills', '  a       v1.4  x', '  longer  -     y']);
});

test('pf vs lists every section, and --json is machine-readable', () => {
  const home = mkRepo({ '.claude/skills/save/SKILL.md': skill('save'), '.claude/skills/save/package.json': JSON.stringify({ name: '@pf-skills/save', version: '2.1.0' }) });
  const env = { HOME: home, PF_HOME: path.join(home, '.pf'), PF_NO_PLUGINS: '1' };
  const r = pf(env, 'vs');
  assert.equal(r.code, 0, r.err);
  for (const title of ['pf', 'Bundled with pf', 'Plugins', 'Skills', 'Presets', 'Cursor extensions']) assert.match(r.out, new RegExp(`^${title}`, 'm'));
  assert.match(r.out, /@pulpfixer\/plugin-aws\s+v\d/);
  assert.match(r.out, /save\s+v2\.1\s+~\/\.claude\/skills, registry/);
  assert.match(r.err, /pf v/, 'the banner stays on stderr');

  const j = pf(env, 'versions', '--json');
  assert.equal(j.code, 0, j.err);
  const data = JSON.parse(j.out) as { sections: { id: string; rows: { name: string; version: string }[] }[] };
  assert.deepEqual(data.sections.map((s) => s.id), ['pf', 'path', 'bundled', 'plugins', 'skills', 'presets', 'extensions']);
  assert.ok(data.sections.find((s) => s.id === 'skills')!.rows.some((x) => x.name === 'save' && x.version === '2.1.0'));

  assert.equal(pf(env, 'versions', '--nope').code, 1);
  assert.equal(pf(env, 'versions', 'extra').code, 1);
});
