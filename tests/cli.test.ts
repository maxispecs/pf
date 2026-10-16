import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const pkgVersion = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
const short = pkgVersion.endsWith('.0') ? pkgVersion.slice(0, -2) : pkgVersion;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', ...extra };
  delete env.FORCE_COLOR;
  return env;
}

function pf(cwd: string, ...args: string[]) {
  const home = mkRepo({});
  const r = spawnSync(process.execPath, ['--import', loader, entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv({ PF_HOME: home }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const repo = () => mkRepo({ '.git/HEAD': '', 'package.json': json({ name: 'demo', scripts: { dev: 'vite' } }), 'pnpm-lock.yaml': '' });

test('every invocation prints the version banner on stderr', () => {
  for (const args of [[], ['list'], ['help'], ['--version'], ['about'], ['nope']]) {
    const r = pf(repo(), ...args);
    assert.match(r.err, new RegExp(`^pf v${short.replace('.', '\\.')}`), `banner missing for: pf ${args.join(' ')}`);
  }
});

test('--version prints the full version on stdout', () => {
  const r = pf(repo(), '--version');
  assert.equal(r.out.trim(), pkgVersion);
  assert.equal(r.code, 0);
});

test('without a terminal, pf prints the static repo list', () => {
  const r = pf(repo());
  assert.equal(r.code, 0);
  assert.match(r.out, /demo/);
  assert.match(r.out, /pf dev\s+Run the app locally\s+pnpm run dev/);
  assert.match(r.err, /demo/);
});

test('outside a repo the fallback list offers skills and about', () => {
  const r = pf(mkRepo({}));
  assert.match(r.out, /Not inside a repo/);
  assert.match(r.out, /pf skill/);
  assert.match(r.out, /pf about/);
  assert.doesNotMatch(r.out, /pf dev/);
});

test('with PF_LOCAL set (./pf), the menu is the local checkout menu', () => {
  const home = mkRepo({});
  const r = spawnSync(process.execPath, ['--import', loader, entry], {
    cwd: repo(),
    encoding: 'utf8',
    env: cleanEnv({ PF_HOME: home, PF_LOCAL: root }),
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^pf v\S+ \(local\)/);
  assert.match(r.stdout, /local checkout/);
  assert.match(r.stdout, /Global pf/);
  assert.match(r.stdout, /pnpm install:local\s+Install pf globally from this checkout/);
  assert.match(r.stdout, /pf update\s+Update the global pf/);
  assert.match(r.stdout, /pf doc\s+Run the docs site locally/);
  assert.match(r.stdout, /pf ver\s+List versions/);
  assert.doesNotMatch(r.stdout, /pf dev/);
});

test('the installed pf ignores a PF_LOCAL that points nowhere', () => {
  const home = mkRepo({});
  const r = spawnSync(process.execPath, ['--import', loader, entry], {
    cwd: repo(),
    encoding: 'utf8',
    env: cleanEnv({ PF_HOME: home, PF_LOCAL: path.join(home, 'missing') }),
  });
  assert.doesNotMatch(r.stderr, /\(local\)/);
  assert.match(r.stdout, /pf dev/);
});

test('dev --dry-run prints the resolved command and runs nothing', () => {
  const r = pf(repo(), 'dev', '--dry-run');
  assert.equal(r.code, 0);
  assert.match(r.err, /would run pnpm run dev/);
});

test('args after -- are passed through', () => {
  const r = pf(repo(), 'dev', '--dry-run', '--', '--port', '4000');
  assert.match(r.err, /would run pnpm run dev --port 4000/);
});

test('custom pf.json commands run by name and appear in the list', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'pf.json': json({ commands: { seed: { run: 'echo seeded', description: 'Load data', group: 'Tools' } } }) });
  assert.match(pf(dir, 'list').out, /pf seed\s+Load data/);
  const r = pf(dir, 'seed');
  assert.equal(r.code, 0);
  assert.match(r.out, /seeded/);
});

test('a missing command explains how to add one', () => {
  const r = pf(mkRepo({ '.git/HEAD': '', 'package.json': '{}' }), 'lint');
  assert.equal(r.code, 1);
  assert.match(r.err, /no lint command found/);
  assert.match(r.err, /pf\.json/);
});

test('unknown commands exit 2 with a hint', () => {
  const r = pf(repo(), 'dve');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "dve"/);
});

test('deploy needs staging and refuses without a terminal or --yes', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'fly.staging.toml': '' });
  assert.equal(pf(dir, 'deploy').code, 2);
  assert.equal(pf(dir, 'deploy', 'staging', '--dry-run').code, 0);
  const r = pf(dir, 'deploy', 'staging');
  assert.equal(r.code, 2);
  assert.match(r.err, /refusing to deploy/);
});

test('ver reports when versioning is not set up and lists when it is', () => {
  const dir = repo();
  assert.equal(pf(dir, 'ver').code, 1);
  assert.match(pf(dir, 'ver').err, /not set up/);
  const init = pf(dir, 'ver', 'init');
  assert.equal(init.code, 0, init.err);
  const list = pf(dir, 'ver', 'list');
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /stack/);
});

test('init writes pf.json and picks it up', () => {
  const dir = repo();
  const r = pf(dir, 'init');
  assert.equal(r.code, 0, r.err);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'pf.json'), 'utf8')) as { commands: Record<string, { run: string }> };
  assert.equal(written.commands.dev!.run, 'pnpm run dev');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'pf.json'), 'utf8')).name, 'demo');
});

test('setup --dry-run changes nothing', () => {
  const home = mkRepo({});
  const r = spawnSync(process.execPath, ['--import', loader, entry, 'setup', '--dry-run'], {
    cwd: repo(),
    encoding: 'utf8',
    env: cleanEnv({ PF_HOME: path.join(home, 'pfhome'), SHELL: '/bin/zsh', HOME: home }),
  });
  assert.match(r.stdout, /dry run/);
  assert.equal(fs.existsSync(path.join(home, 'pfhome')), false);
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
});

test('without a terminal the header stays one line, even for the menu, about and help', () => {
  for (const args of [[], ['about'], ['help'], ['menu']]) {
    const r = pf(repo(), ...args);
    assert.doesNotMatch(r.err, /██/, `logo leaked for: pf ${args.join(' ')}`);
    assert.equal(r.err.trim().split('\n').length, 1, `banner is not one line for: pf ${args.join(' ')}`);
  }
});

test('uninstall without a terminal or --yes cancels and names the flag; flags pick the parts', () => {
  const r = pf(repo(), 'uninstall');
  assert.equal(r.code, 130);
  assert.match(r.err, /pass --yes/);
  const dry = pf(repo(), 'uninstall', '--yes', '--no-package', '--no-shell', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.doesNotMatch(dry.err, /npm rm/);
  assert.match(dry.out, /kept/);
});
