import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { discoverSkills } from '../src/skills/discover.js';
import { installSkills, retireStackSkills, updateSkills } from '../src/skills/manage.js';
import { packagedSkill } from '../src/skills/packages.js';
import { inspectPath, installedSkills, targetDir } from '../src/skills/registry.js';
import { json, mkRepo } from './helpers.js';

// Keep the real ~/.pf/skills out of every test here.
process.env.PF_HOME = mkRepo();

test('pf skill install copies a shipped skill, `ver` means `version`, and the copy is marked as ours', () => {
  const home = mkRepo();
  assert.equal(installSkills(['ver'], ['cursor'], { home }), 0);
  const dest = path.join(home, '.cursor/skills/version');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dest, 'scripts', 'version.mjs')));
  const shipped = packagedSkill('version')!;
  assert.deepEqual(inspectPath(dest), { kind: 'registry', package: '@pulpfixer/skill-version', version: shipped.version });
  assert.ok(!fs.existsSync(path.join(home, '.cursor/skills/ver')));
  assert.deepEqual(installedSkills(home).map((s) => [s.name, s.target]), [['version', 'cursor']]);
  // Installing again changes nothing.
  assert.equal(installSkills(['version'], ['cursor'], { home }), 0);
});

test('the pnpm and deploy-setup skills install from pf too, and a dry run writes nothing', () => {
  const home = mkRepo();
  assert.equal(installSkills(['pnpm', 'deploy-setup'], ['claude'], { home, dryRun: true }), 0);
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills')));
  assert.equal(installSkills(['pnpm', 'deploy-setup'], ['claude'], { home }), 0);
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/pnpm/scripts/tasks.mjs')));
  assert.equal(inspectPath(path.join(home, '.claude/skills/deploy-setup')).package, '@pulpfixer/skill-repo');
});

test('pf skill update recopies a shipped skill that is older than the one in pf, and leaves a symlink', () => {
  const home = mkRepo();
  assert.equal(installSkills(['version'], ['cursor'], { home }), 0);
  const dest = path.join(home, '.cursor/skills/version');
  fs.writeFileSync(path.join(dest, 'package.json'), json({ name: '@pulpfixer/skill-version', version: '0.1.0' }));
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '---\nname: version\n---\nold\n');
  assert.equal(updateSkills([], { home, check: true }), 0);
  assert.match(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /old/);
  assert.equal(updateSkills([], { home }), 0);
  assert.doesNotMatch(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /^---\nname: version\n---\nold/);
  assert.equal(inspectPath(dest).version, packagedSkill('version')!.version);
});

test('retireStackSkills removes the old registry installs of ver and pnpm in pf\'s folder, never a symlink or a hand-made folder', () => {
  const pf = targetDir('pf');
  fs.mkdirSync(pf, { recursive: true });
  const mk = (name: string, pkg: string) => {
    fs.mkdirSync(path.join(pf, name), { recursive: true });
    fs.writeFileSync(path.join(pf, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    fs.writeFileSync(path.join(pf, name, 'package.json'), json({ name: pkg, version: '1.0.0' }));
  };
  mk('ver', '@pf-skills-ver/ver');
  mk('pnpm', '@pf-skills/pnpm');
  assert.equal(retireStackSkills({ check: true }), 0);
  assert.ok(fs.existsSync(path.join(pf, 'ver')), 'check removes nothing');
  assert.equal(retireStackSkills({ dryRun: true }), 0);
  assert.ok(fs.existsSync(path.join(pf, 'pnpm')), 'dry run removes nothing');
  assert.equal(retireStackSkills(), 0);
  assert.ok(!fs.existsSync(path.join(pf, 'ver')));
  assert.ok(!fs.existsSync(path.join(pf, 'pnpm')));

  const checkout = mkRepo({ 'ver/SKILL.md': '---\nname: ver\n---\n' });
  fs.symlinkSync(path.join(checkout, 'ver'), path.join(pf, 'ver'));
  fs.mkdirSync(path.join(pf, 'pnpm'));
  fs.writeFileSync(path.join(pf, 'pnpm', 'SKILL.md'), '---\nname: pnpm\n---\n');
  assert.equal(retireStackSkills(), 0);
  assert.equal(fs.lstatSync(path.join(pf, 'ver')).isSymbolicLink(), true);
  assert.ok(fs.existsSync(path.join(pf, 'pnpm', 'SKILL.md')));
});

test('discovery finds the shipped skills with the pulpfixer label, and an agent copy of the same name wins', () => {
  const home = mkRepo({ '.agents/skills/pf-repo/SKILL.md': '---\nname: pf-repo\ndescription: Mine.\n---\n' });
  const skills = discoverSkills(null, {}, home, undefined, null);
  const by = (n: string) => skills.find((s) => s.name === n);
  for (const n of ['version', 'pnpm', 'deploy-setup']) assert.equal(by(n)?.source, 'pulpfixer', n);
  assert.equal(by('pf-repo')?.source, '~/.agents/skills');
  assert.equal(by('ver'), undefined);
});
