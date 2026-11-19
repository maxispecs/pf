#!/usr/bin/env node
// Check, build and publish pf to the cellars registry.
//
//   node scripts/release.mjs             checks + build + `npm publish --dry-run` (publishes nothing)
//   node scripts/release.mjs --publish   the same, then a real publish
//
// Publishes every package under packages/ whose version the registry does not have yet, in dependency
// order (kit, plugins, extensions and presets, core). Versions come from each package.json, which `pnpm ver bump <package> minor`
// keeps in step with versions.json. A published version can never be reused, so bump first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://cellars.staging.pangenea.com/';
const HOST = 'cellars.staging.pangenea.com';
const publish = process.argv.includes('--publish');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, red, green, yellow] = [paint('1'), paint('2'), paint('31'), paint('32'), paint('33')];
const step = (s) => console.log(`\n${bold(s)}`);
const ok = (s) => console.log(`  ${green('✔')} ${s}`);
const warn = (s) => console.log(`  ${yellow('!')} ${s}`);
const die = (s) => {
  console.error(`  ${red('✘')} ${s}`);
  process.exit(1);
};

// The repo .npmrc reads the registry token from ${NPM_TOKEN}, and a project .npmrc overrides ~/.npmrc, so a
// token saved by `npm login` is shadowed. When NPM_TOKEN is unset, load it from the user .npmrc into this
// process's environment (child processes inherit it). The value is never printed.
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const ORDER = ['kit', 'plugin-aws', 'plugin-db', 'plugin-system', 'plugin-yubikey', 'db-postgres', 'db-mysql', 'ext-bg-tone', 'preset-cursor', 'preset-suite', 'template-query-package', 'pulpfixer'];
// Presets and templates (data), suite extensions (a .vsix) and database drivers (registry plugins, `pf plugin install db-<name>`)
// are fetched at their latest version, so core does not pin them.
const isPreset = (p) => ['preset-', 'ext-', 'db-', 'template-'].some((k) => p.name.startsWith(`@pulpfixer/${k}`));
const capture = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });

function userNpmrcToken() {
  const userNpmrc = process.env.NPM_CONFIG_USERCONFIG ?? path.join(process.env.HOME ?? '', '.npmrc');
  try {
    const m = fs
      .readFileSync(userNpmrc, 'utf8')
      .match(new RegExp(`^//${HOST.replace(/\./g, '\\.')}/:_authToken=(?!\\$\\{)(\\S+)\\s*$`, 'm'));
    return m ? m[1] : null;
  } catch {
    return null; // no user .npmrc
  }
}

/** True when `npm whoami` accepts the current NPM_TOKEN. */
const tokenWorks = () => capture('npm', ['whoami', '--registry', REGISTRY]).status === 0;

// Use the token from the user .npmrc when NPM_TOKEN is unset, or set but rejected (for example a stale value
// exported before a re-login). Child processes inherit process.env. Token values are never printed.
function ensureAuth() {
  const fromFile = userNpmrcToken();
  if (process.env.NPM_TOKEN && tokenWorks()) return true;
  if (fromFile) {
    if (process.env.NPM_TOKEN && process.env.NPM_TOKEN !== fromFile) warn('NPM_TOKEN in your environment was rejected: using the token from ~/.npmrc instead (unset NPM_TOKEN to silence this)');
    process.env.NPM_TOKEN = fromFile;
    return tokenWorks();
  }
  return false;
}

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

const pkgs = ORDER.map((name) => {
  const dir = path.join(root, 'packages', name);
  return { dir, ...JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), rel: `packages/${name}` };
});
console.log(`${bold('release')} ${pkgs.map((p) => `${p.name}@${p.version}`).join(', ')} ${dim(publish ? '(publish)' : '(dry run: nothing is published)')}`);

step('Version');
let versions = null;
try {
  versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
} catch {
  warn('no readable versions.json: skipping the drift check');
}
for (const p of pkgs) {
  const want = versions && String(versions.packages?.[p.rel]?.version ?? '');
  const mm = p.version.split('.').slice(0, 2).join('.');
  if (want && want !== mm) die(`versions.json says ${p.rel} is ${want} but its package.json is ${p.version}. Run: pnpm ver sync`);
  if (want) ok(`${p.name} ${p.version} matches versions.json`);
}

ensureAuth();
const todo = [];
for (const p of pkgs) {
  const latest = capture('npm', ['view', p.name, 'version', '--registry', REGISTRY]);
  const published = latest.status === 0 ? latest.stdout.trim().split('\n').pop().trim() : null;
  if (published && cmp(p.version, published) <= 0) {
    ok(`${p.name} ${p.version}: registry has ${published}, nothing to publish`);
  } else {
    if (published) ok(`${p.name} ${p.version} is newer than the registry's ${published}`);
    else warn(`${p.name}: could not read the registry (offline, or NPM_TOKEN is not set) or not published yet`);
    todo.push(p);
  }
}
// core pins kit and the plugins to exact versions, and users only update `pulpfixer` itself, so a
// dependency published without a new core would never reach anyone. Presets are not pinned: they reach users alone.
const pinned = todo.filter((p) => !isPreset(p));
if (pinned.length && !todo.some((p) => p.name === 'pulpfixer')) {
  const msg = `${pinned.map((p) => p.name).join(', ')} changed but pulpfixer (core) did not: users update core, which pins its dependencies. Bump it too: pnpm ver bump packages/pulpfixer minor`;
  if (publish) die(msg);
  warn(msg);
}
if (!todo.length) {
  if (publish) die('every package is already published: bump first (pnpm ver bump <package> minor)');
  warn('nothing is newer than the registry, so a publish would do nothing. Bump first: pnpm ver bump <package> minor');
}

step('Checks');
for (const script of ['typecheck', 'test', 'build']) {
  console.log(dim(`$ pnpm run ${script}`));
  const r = run('pnpm', ['run', script]);
  if (r.status !== 0) die(`${script} failed`);
  ok(script);
}

step('Package contents');
for (const p of todo) {
  console.log(dim(`$ npm pack --dry-run (${p.rel})`));
  if (run('npm', ['pack', '--dry-run'], { cwd: p.dir }).status !== 0) die(`npm pack failed for ${p.name}`);
}

step(publish ? 'Publish' : 'Publish (dry run)');
const label = todo.map((p) => `${p.name}@${p.version}`).join(', ');
// pnpm publish turns the workspace:* dependencies into the real versions; npm publish would not.
const pub = (p, extra = []) => run('pnpm', ['publish', '--no-git-checks', '--registry', REGISTRY, ...extra], { cwd: p.dir });
if (publish) {
  if (!ensureAuth()) die('no valid registry token (npm whoami failed): run `npm login --auth-type=web --registry ' + REGISTRY + '`');
  ok(`registry auth ok (${capture('npm', ['whoami', '--registry', REGISTRY]).stdout.trim()})`);
  console.log(`Publishing ${label} to ${REGISTRY}`);
  for (const p of todo) {
    if (pub(p).status !== 0) die(`publish failed for ${p.name}`);
    ok(`published ${p.name}@${p.version}`);
  }
} else {
  for (const p of todo) {
    if (pub(p, ['--dry-run']).status !== 0) die(`publish --dry-run failed for ${p.name}`);
  }
  ok('dry run passed. Publish for real with: pnpm publish:cellars');
}
