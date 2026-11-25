import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isRepoSetUp, resolveTasksHelper, wireVerScript } from '../src/commands/repo.js';
import { resolveVerCli } from '../src/commands/ver.js';
import { packagedSkill, packagedSkillFile, packagedSkills } from '../src/skills/packages.js';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
const bundledVer = fs.readFileSync(resolveVerCli(), 'utf8');

function pf(cwd: string, ...args: string[]) {
  return pfHome(mkRepo({}), cwd, ...args);
}

function pfHome(home: string, cwd: string, ...args: string[]) {
  const env = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_NO_TRAVOLTA: '1', PF_HOME: home };
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}

const demo = () =>
  mkRepo({
    '.git/HEAD': '',
    'package.json': json({ name: 'demo', version: '1.2.0', scripts: { build: 'tsc' } }),
    'pnpm-lock.yaml': '',
  });

test('pf repo installs the pnpm helper and versioning, and wires package.json', () => {
  const dir = demo();
  const r = pf(dir, 'repo');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(dir, 'scripts', 'tasks.mjs')));
  assert.equal(fs.readFileSync(path.join(dir, 'scripts', 'version.mjs'), 'utf8'), bundledVer);
  assert.ok(fs.existsSync(path.join(dir, 'versions.json')));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.ask, 'node scripts/tasks.mjs ask');
  assert.equal(pkg.scripts.ver, 'node scripts/version.mjs');
  assert.equal(pkg.scriptsInfo.Tools.ver, 'List versions and bump commands');
  assert.match(r.out, /installed scripts\/version\.mjs/);
});

test('pf repo keeps .pf/ out of git: it adds it to .gitignore once, and --no-local and --dry-run skip it', () => {
  const dir = demo();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  const dry = pf(dir, 'repo', '--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /would add \.pf\//);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n');
  assert.equal(pf(dir, 'repo', '--no-local').code, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n');
  const r = pf(dir, 'repo');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /local settings: added \.pf\//);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n.pf/\n');
  assert.match(pf(dir, 'repo').out, /\.pf\/ is already in \.gitignore/);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n.pf/\n');
});

test('pf repo --dry-run writes nothing', () => {
  const dir = demo();
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const r = pf(dir, 'repo', '--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(dir, 'scripts')));
  assert.ok(!fs.existsSync(path.join(dir, 'versions.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'pulpfixer.json')));
  assert.match(r.out, /would add id demo-/);
});

test('pf rp links pulpfixer.json to a record in the pf home, then reports it linked; --list shows it', () => {
  const home = mkRepo({});
  const dir = demo();
  const r = pfHome(home, dir, 'rp', '--no-pnpm', '--no-ver', '--no-deploy');
  assert.equal(r.code, 0, r.out);
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'pulpfixer.json'), 'utf8')).id as string;
  assert.match(id, /^demo-[0-9a-f]{8}$/);
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'repos', `${id}.json`), 'utf8'));
  assert.deepEqual(rec.paths, [fs.realpathSync(dir)]);

  const again = pfHome(home, dir, 'rp', '--no-pnpm', '--no-ver', '--no-deploy');
  assert.match(again.out, new RegExp(`linked as ${id}`));
  assert.match(pfHome(home, dir, 'rp', '--list').out, new RegExp(id));
});

test('pf rp without a terminal leaves a foreign id alone and says how to choose', () => {
  const home = mkRepo({});
  const first = demo();
  assert.equal(pfHome(home, first, 'rp', '--no-pnpm', '--no-ver', '--no-deploy').code, 0);
  const id = JSON.parse(fs.readFileSync(path.join(first, 'pulpfixer.json'), 'utf8')).id as string;
  const copy = mkRepo({ 'pulpfixer.json': json({ id }), 'package.json': json({ name: 'demo' }) });
  const r = pfHome(home, copy, 'rp', '--no-pnpm', '--no-ver', '--no-deploy');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /run pf rp in a terminal to choose/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy, 'pulpfixer.json'), 'utf8')).id, id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'repos', `${id}.json`), 'utf8')).paths.length, 1);
});

test('pf rp converts a legacy pf.json to pulpfixer.json, keeping its commands, and links it', () => {
  const home = mkRepo({});
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ name: 'demo' }), 'pf.json': json({ commands: { seed: './seed.sh' } }) });
  const dry = pfHome(home, dir, 'rp', '--dry-run', '--no-pnpm', '--no-ver', '--no-deploy');
  assert.match(dry.out, /would rename pf\.json to pulpfixer\.json/);
  assert.ok(fs.existsSync(path.join(dir, 'pf.json')));

  const r = pfHome(home, dir, 'rp', '--no-pnpm', '--no-ver', '--no-deploy');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /renamed pf\.json to pulpfixer\.json/);
  assert.match(r.out, /demo is set up for pulpfixer/);
  assert.ok(!fs.existsSync(path.join(dir, 'pf.json')));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'pulpfixer.json'), 'utf8'));
  assert.equal(cfg.commands.seed, './seed.sh');
  assert.match(cfg.id, /^demo-[0-9a-f]{8}$/);
});

test('pf rp leaves a pf.json that differs from pulpfixer.json and warns', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ name: 'demo' }), 'pf.json': json({ name: 'a' }), 'pulpfixer.json': json({ name: 'b' }) });
  const r = pf(dir, 'rp', '--no-pnpm', '--no-ver', '--no-deploy');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pf reads only pulpfixer\.json/);
  assert.ok(fs.existsSync(path.join(dir, 'pf.json')));
});

test('pf rp updates an older ver CLI copy and leaves a newer one', () => {
  const dir = demo();
  assert.equal(pf(dir, 'rp').code, 0);
  const cli = path.join(dir, 'scripts', 'version.mjs');
  const extra = path.join(dir, 'tools', 'version.mjs');
  fs.writeFileSync(cli, bundledVer.replace(/const CLI_VERSION = \d+;/, 'const CLI_VERSION = 1;'));
  fs.mkdirSync(path.dirname(extra));
  fs.writeFileSync(extra, bundledVer.replace(/const CLI_VERSION = \d+;/, 'const CLI_VERSION = 9999;'));
  const r = pf(dir, 'rp');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(cli, 'utf8'), bundledVer);
  assert.match(r.out, /updated scripts\/version\.mjs \(revision 1 ->/);
  assert.match(fs.readFileSync(extra, 'utf8'), /CLI_VERSION = 9999/);
  assert.match(r.out, /tools\/version\.mjs is newer than pf's copy/);
});

test('wireVerScript keeps a foreign ver script and uses versions instead', () => {
  const pkg = { scripts: { ver: 'echo mine' }, scriptsInfo: { Tools: {} } };
  wireVerScript(pkg, 'scripts/version.mjs');
  assert.equal(pkg.scripts.ver, 'echo mine');
  assert.equal((pkg.scripts as Record<string, string>).versions, 'node scripts/version.mjs');
  assert.ok('versions' in pkg.scriptsInfo.Tools);
});

const bundledTasks = fs.readFileSync(resolveTasksHelper(), 'utf8');

const withRevision = (n: number) => bundledVer.replace(/const CLI_VERSION = \d+;/, `const CLI_VERSION = ${n};`);

test('the version CLI and the pnpm helper come from the skill packages that ship with pf', () => {
  const ver = resolveVerCli();
  const tasks = resolveTasksHelper();
  assert.match(ver.split(path.sep).join('/'), /skill-version\/skills\/version\/scripts\/version\.mjs$/);
  assert.match(tasks.split(path.sep).join('/'), /skill-repo\/skills\/pnpm\/scripts\/tasks\.mjs$/);
  assert.ok(fs.existsSync(ver) && fs.existsSync(tasks));
  assert.equal(ver, packagedSkillFile('ver', 'scripts/version.mjs'), 'ver is an alias of version');
});

test('pf ships the version, pf-repo, deploy-setup and pnpm skills, and ver names version', () => {
  const names = packagedSkills().map((s) => s.name);
  assert.deepEqual(names, ['deploy-setup', 'pf-repo', 'pnpm', 'version']);
  assert.equal(packagedSkill('ver')?.name, 'version');
  assert.equal(packagedSkill('version')?.package, '@pulpfixer/skill-version');
  assert.equal(packagedSkill('deploy-setup')?.package, '@pulpfixer/skill-repo');
  assert.equal(packagedSkill('nope'), null);
  for (const s of packagedSkills()) assert.match(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), new RegExp(`^---\\nname: ${s.name}\\n`));
});

test('this repo\'s own scripts/version.mjs and scripts/tasks.mjs are copies of the skill packages (pnpm skills:sync)', () => {
  const repoRoot = path.resolve(root, '..', '..');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'scripts', 'version.mjs'), 'utf8'), bundledVer);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'scripts', 'tasks.mjs'), 'utf8'), bundledTasks);
});

test('pf update --repo-only refreshes the ver CLI and the pnpm helper copies, and leaves unrelated or newer files', () => {
  const dir = demo();
  assert.equal(pf(dir, 'repo').code, 0);
  const cli = path.join(dir, 'scripts', 'version.mjs');
  const tasks = path.join(dir, 'scripts', 'tasks.mjs');
  fs.writeFileSync(cli, withRevision(1));
  fs.writeFileSync(tasks, bundledTasks + '\n// old\n');
  const r = pf(dir, 'update', '--repo-only');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(cli, 'utf8'), bundledVer);
  assert.equal(fs.readFileSync(tasks, 'utf8'), bundledTasks);
  assert.match(r.out, /updated scripts\/version\.mjs from revision 1/);
  assert.match(r.out, /updated scripts\/tasks\.mjs/);

  const again = pf(dir, 'update', '--repo-only');
  assert.match(again.out, /scripts\/version\.mjs is current/);
  assert.match(again.out, /scripts\/tasks\.mjs is current/);

  fs.writeFileSync(cli, withRevision(9999));
  fs.writeFileSync(tasks, '// my own tasks\n');
  const left = pf(dir, 'update', '--repo-only');
  assert.match(left.out, /scripts\/version\.mjs is newer/);
  assert.equal(fs.readFileSync(tasks, 'utf8'), '// my own tasks\n');
});

test('pf update --repo-only --check and --dry-run write nothing', () => {
  const dir = demo();
  assert.equal(pf(dir, 'repo').code, 0);
  const cli = path.join(dir, 'scripts', 'version.mjs');
  fs.writeFileSync(cli, withRevision(1));
  for (const flag of ['--check', '--dry-run']) {
    const r = pf(dir, 'update', '--repo-only', flag);
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(cli, 'utf8'), withRevision(1));
    assert.match(r.out, /update scripts\/version\.mjs from revision 1/);
  }
});

test('isRepoSetUp is false for a fresh repo and true after pf repo or with a versions.json', () => {
  const dir = demo();
  assert.equal(isRepoSetUp(dir), false);
  assert.equal(pf(dir, 'repo').code, 0);
  assert.equal(isRepoSetUp(dir), true);
  assert.equal(isRepoSetUp(mkRepo({ 'versions.json': '{}' })), true);
  assert.equal(isRepoSetUp(mkRepo({ 'scripts/tasks.mjs': '// my own tasks\n' })), false);
});

test('pf dev in a repo pf repo was not run in does not ask without a terminal', () => {
  const dir = demo();
  const r = pf(dir, 'dev', '--dry-run');
  assert.doesNotMatch(r.out, /not set up with pf/);
  assert.equal(isRepoSetUp(dir), false);
});
