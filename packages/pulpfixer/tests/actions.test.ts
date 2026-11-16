import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRepoConfig } from '@pulpfixer/kit/config';
import { buildContext } from '@pulpfixer/kit/context';
import { actionsDocument, listActions, setFeatured } from '../src/commands/actions.js';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

function pf(cwd: string, ...args: string[]) {
  const env = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_HOME: mkRepo({}) };
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const SCRIPTS = {
  dev: 'node app.js',
  build: 'tsc',
  'deploy:staging': 'echo staging',
  'publish:staging': 'echo publish',
  docs: 'echo docs',
  'install:local': 'echo install',
};

const repo = (config: unknown = undefined, scripts: Record<string, string> = SCRIPTS) =>
  mkRepo({
    '.git/HEAD': '',
    'package.json': json({ name: 'demo', scripts }),
    'pnpm-lock.yaml': '',
    ...(config === undefined ? {} : { 'pulpfixer.json': json(config) }),
  });

const ids = (dir: string, all = true) => actionsDocument(buildContext(dir), all).actions.map((a) => a.id);

test('run, deploy, publish and docs are featured by default; install and build are not', () => {
  const dir = repo();
  assert.deepEqual(ids(dir, false).sort(), ['deploy:staging', 'dev', 'doc', 'publish:staging']);
  assert.ok(ids(dir).includes('build'));
  assert.ok(ids(dir).includes('install:local'));
});

test('each action carries the pf arguments that run it and a codicon', () => {
  const byId = Object.fromEntries(listActions(buildContext(repo())).map((a) => [a.id, a]));
  assert.deepEqual(byId['deploy:staging']?.argv, ['deploy', 'staging']);
  assert.deepEqual(byId['install:local']?.argv, ['install', 'local']);
  assert.deepEqual(byId['publish:staging']?.argv, ['publish', 'staging']);
  assert.equal(byId.dev?.icon, 'play');
  assert.equal(byId['deploy:staging']?.icon, 'rocket');
  assert.equal(byId['deploy:staging']?.label, 'Deploy to staging');
});

test('a custom command is featured only when it says so, with its own icon and label', () => {
  const dir = repo({
    commands: {
      seed: { run: './seed.sh', description: 'Seed the database', icon: 'database', featured: true },
      cleanup: './clean.sh',
    },
  });
  const byId = Object.fromEntries(listActions(buildContext(dir)).map((a) => [a.id, a]));
  assert.equal(byId.seed?.featured, true);
  assert.equal(byId.seed?.icon, 'database');
  assert.equal(byId.seed?.label, 'Seed the database');
  assert.deepEqual(byId.seed?.argv, ['seed']);
  assert.equal(byId.cleanup?.featured, false);
  assert.equal(byId.cleanup?.icon, 'terminal');
  assert.equal(byId.cleanup?.label, 'cleanup');
});

test('the actions section beats the defaults and a custom command', () => {
  const dir = repo({
    commands: { seed: { run: 'x', featured: true, icon: 'database' } },
    actions: { dev: { featured: false }, build: { featured: true, icon: 'tools' }, seed: { icon: 'flame' } },
  });
  const byId = Object.fromEntries(listActions(buildContext(dir)).map((a) => [a.id, a]));
  assert.equal(byId.dev?.featured, false);
  assert.equal(byId.build?.featured, true);
  assert.equal(byId.build?.icon, 'tools');
  assert.equal(byId.seed?.featured, true);
  assert.equal(byId.seed?.icon, 'flame');
});

test('outside a repo there are no actions', () => {
  assert.deepEqual(listActions(buildContext(mkRepo({}))), []);
});

test('pf actions --json prints the document on stdout only', () => {
  const r = pf(repo(), 'actions', '--json');
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.out);
  assert.equal(doc.schema, 1);
  assert.equal(typeof doc.repo, 'string');
  assert.deepEqual(doc.actions.map((a: { id: string }) => a.id).sort(), ['deploy:staging', 'dev', 'doc', 'publish:staging']);
  const all = JSON.parse(pf(repo(), 'actions', '--all', '--json').out);
  assert.ok(all.actions.length > doc.actions.length);
});

test('pf actions feature / unfeature write the actions section and keep the rest of the file', () => {
  const dir = repo({ id: 'demo-1', commands: { seed: 'x' } });
  assert.equal(pf(dir, 'actions', 'feature', 'build', 'seed', '--icon', 'package').code, 0);
  assert.equal(pf(dir, 'actions', 'unfeature', 'dev').code, 0);
  const cfg = loadRepoConfig(dir);
  assert.equal(cfg.id, 'demo-1');
  assert.equal(cfg.commands.seed?.run, 'x');
  assert.deepEqual(cfg.actions, {
    build: { featured: true, icon: 'package' },
    seed: { featured: true, icon: 'package' },
    dev: { featured: false },
  });
  const featured = ids(dir, false);
  assert.ok(featured.includes('build') && featured.includes('seed') && !featured.includes('dev'));
});

test('feature keeps an icon set earlier, and --dry-run writes nothing', () => {
  const dir = repo({ actions: { build: { icon: 'package' } } });
  const file = path.join(dir, 'pulpfixer.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(pf(dir, 'actions', 'feature', 'build', '--dry-run').code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(pf(dir, 'actions', 'feature', 'build').code, 0);
  assert.deepEqual(loadRepoConfig(dir).actions?.build, { icon: 'package', featured: true });
});

test('feature refuses an unknown id, a bad icon and a missing id, and changes nothing', () => {
  const dir = repo({ id: 'x-1' });
  const file = path.join(dir, 'pulpfixer.json');
  const before = fs.readFileSync(file, 'utf8');
  const unknown = pf(dir, 'actions', 'feature', 'nope');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no such action: nope/);
  assert.equal(pf(dir, 'actions', 'feature', 'build', '--icon', 'Bad Icon').code, 1);
  assert.equal(pf(dir, 'actions', 'feature').code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('setFeatured refuses a pulpfixer.json that is not valid JSON', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'pulpfixer.json'), '{ nope');
  const before = fs.readFileSync(path.join(dir, 'pulpfixer.json'), 'utf8');
  assert.equal(setFeatured(buildContext(dir), ['dev'], false), 1);
  assert.equal(fs.readFileSync(path.join(dir, 'pulpfixer.json'), 'utf8'), before);
});
