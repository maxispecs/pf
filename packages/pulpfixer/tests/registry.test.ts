import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  candidatePackages,
  inspectPath,
  installTarball,
  installedSkills,
  isSkillPackage,
  parseSearch,
  parseTargets,
  pickSkillPackages,
  skillOfPackage,
  targetDir,
} from '../src/skills/registry.js';
import { json, mkRepo } from './helpers.js';

// Keep the real ~/.pf/skills out of installedSkills().
process.env.PF_HOME = mkRepo();

test('recognizes default and own skill packages', () => {
  assert.ok(isSkillPackage('@pf-skills/ver'));
  assert.ok(isSkillPackage('@pf-skills-ver/ver'));
  assert.ok(isSkillPackage('@pf-skills-nucleotide/nucleotide'));
  assert.ok(!isSkillPackage('@pf-skillsx/ver'));
  assert.ok(!isSkillPackage('@ts-pf/client'));
  assert.ok(!isSkillPackage('pulpfixer'));
  assert.equal(skillOfPackage('@pf-skills-ver/ver'), 'ver');
  assert.deepEqual(candidatePackages('ver'), ['@pf-skills/ver', '@pf-skills-ver/ver']);
  assert.deepEqual(candidatePackages('@pf-skills-ver/ver'), ['@pf-skills-ver/ver']);
});

test('search results keep skill packages only, own package first', () => {
  const raw = `npm notice something\n[\n{"name":"@ts-pf/client","version":"0.1.5"}\n,\n{"name":"@pf-skills/ver","version":"1.3.0","description":"old"}\n,{"name":"@pf-skills-ver/ver","version":"1.4.0","description":"own"},{"name":"@pf-skills/bp","version":"2.0.0"}]`;
  const skills = pickSkillPackages(parseSearch(raw));
  assert.deepEqual(skills.map((s) => [s.name, s.package, s.version]), [
    ['bp', '@pf-skills/bp', '2.0.0'],
    ['ver', '@pf-skills-ver/ver', '1.4.0'],
  ]);
  assert.deepEqual(parseSearch('not json'), []);
});

test('targets parse agent names, aliases and all', () => {
  assert.deepEqual(parseTargets('claude,cursor-agent'), ['claude', 'cursor']);
  assert.deepEqual(parseTargets('pulpfixer'), ['pf']);
  assert.deepEqual(parseTargets('all'), ['pf', 'cursor', 'claude', 'agents']);
  assert.equal(parseTargets('codex'), null);
  assert.equal(parseTargets('vim'), null);
});

function tarball(dir: string, files: Record<string, string>): string {
  const src = mkRepo(Object.fromEntries(Object.entries(files).map(([k, v]) => [`package/${k}`, v])));
  const file = path.join(dir, 'skill.tgz');
  execFileSync('tar', ['-czf', file, '-C', src, 'package']);
  return file;
}

test('installs a tarball, replaces its own install, leaves other folders alone', () => {
  const home = mkRepo({ '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\n' });
  const work = mkRepo();
  const dest = path.join(home, '.claude/skills/ver');
  const skill = '---\nname: ver\ndescription: Versions.\n---\n';
  installTarball(tarball(work, { 'SKILL.md': skill, 'package.json': json({ name: '@pf-skills/ver', version: '1.3.0' }) }), dest);
  assert.deepEqual(inspectPath(dest), { kind: 'registry', package: '@pf-skills/ver', version: '1.3.0' });

  installTarball(tarball(work, { 'SKILL.md': skill, 'scripts/x.mjs': '', 'package.json': json({ name: '@pf-skills/ver', version: '1.4.0' }) }), dest);
  assert.equal(inspectPath(dest).version, '1.4.0');
  assert.ok(fs.existsSync(path.join(dest, 'scripts/x.mjs')));
  assert.deepEqual(fs.readdirSync(path.dirname(dest)).sort(), ['mine', 'ver']);

  const mine = path.join(home, '.claude/skills/mine');
  const other = tarball(work, { 'SKILL.md': '---\nname: mine\n---\n', 'package.json': json({ name: '@pf-skills/mine', version: '1.0.0' }) });
  assert.throws(() => installTarball(other, mine), /not installed from the registry/);
  assert.equal(inspectPath(mine).kind, 'other');
  assert.throws(() => installTarball(tarball(work, { 'SKILL.md': '---\nname: bp\n---\n' }), path.join(home, '.claude/skills/x')), /named "bp"/);

  assert.deepEqual(installedSkills(home).map((s) => [s.name, s.target, s.version]), [['ver', 'claude', '1.4.0']]);
});

test("pf's own folder lives under PF_HOME and its installs are listed first", () => {
  const pfHome = mkRepo();
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = pfHome;
  try {
    const home = mkRepo({ '.cursor/skills/bp/SKILL.md': '---\nname: bp\n---\n', '.cursor/skills/bp/package.json': json({ name: '@pf-skills/bp', version: '0.2.0' }) });
    assert.equal(targetDir('pf', home), path.join(pfHome, 'skills'));
    const work = mkRepo();
    installTarball(tarball(work, { 'SKILL.md': '---\nname: ver\n---\n', 'package.json': json({ name: '@pf-skills-ver/ver', version: '1.5.0' }) }), path.join(targetDir('pf', home), 'ver'));
    assert.deepEqual(installedSkills(home).map((s) => [s.name, s.target, s.package]), [
      ['ver', 'pf', '@pf-skills-ver/ver'],
      ['bp', 'cursor', '@pf-skills/bp'],
    ]);
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
  }
});

test('symlinked skills (a skills checkout) are never treated as registry installs', () => {
  const home = mkRepo({ 'checkout/ver/SKILL.md': '---\nname: ver\n---\n', 'checkout/ver/package.json': json({ name: '@pf-skills/ver', version: '1.0.0' }) });
  fs.mkdirSync(path.join(home, '.cursor/skills'), { recursive: true });
  fs.symlinkSync(path.join(home, 'checkout/ver'), path.join(home, '.cursor/skills/ver'));
  assert.equal(inspectPath(path.join(home, '.cursor/skills/ver')).kind, 'link');
  assert.deepEqual(installedSkills(home), []);
});
