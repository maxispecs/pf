#!/usr/bin/env node
// Check, build and publish pf to the cellars registry.
//
//   node scripts/release.mjs             checks + build + `npm publish --dry-run` (publishes nothing)
//   node scripts/release.mjs --publish   the same, then a real publish after you type the version to confirm
//
// The version to publish is package.json's, which `pnpm ver bump stack minor` keeps in step with
// versions.json. A published version can never be reused, so bump first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
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

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const capture = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`${bold('release')} ${pkg.name}@${pkg.version} ${dim(publish ? '(publish)' : '(dry run: nothing is published)')}`);

step('Version');
try {
  const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
  const stack = String(versions.stack?.version ?? versions.version ?? '');
  const mm = pkg.version.split('.').slice(0, 2).join('.');
  if (stack && stack !== mm) die(`versions.json says ${stack} but package.json is ${pkg.version}. Run: pnpm ver sync`);
  ok(`package.json ${pkg.version} matches versions.json`);
} catch {
  warn('no readable versions.json: skipping the drift check');
}

const latest = capture('npm', ['view', pkg.name, 'version', '--registry', REGISTRY]);
const published = latest.status === 0 ? latest.stdout.trim().split('\n').pop().trim() : null;
if (published) {
  if (cmp(pkg.version, published) > 0) ok(`${pkg.version} is newer than the registry's ${published}`);
  else if (publish) die(`the registry already has ${published}: bump first (pnpm ver bump stack minor)`);
  else warn(`the registry already has ${published}, so ${pkg.version} could not be published. Bump first: pnpm ver bump stack minor`);
} else {
  warn('could not read the registry (offline, or NPM_TOKEN is not set). Version freshness not checked');
}

step('Checks');
for (const script of ['typecheck', 'test', 'build']) {
  console.log(dim(`$ pnpm run ${script}`));
  const r = run('pnpm', ['run', script]);
  if (r.status !== 0) die(`${script} failed`);
  ok(script);
}

step('Package contents');
const pack = run('npm', ['pack', '--dry-run']);
if (pack.status !== 0) die('npm pack failed');

step(publish ? 'Publish' : 'Publish (dry run)');
if (publish) {
  const npmrc = process.env.NPM_CONFIG_USERCONFIG ?? path.join(process.env.HOME ?? '', '.npmrc');
  let hasAuth = false;
  try {
    hasAuth = new RegExp(`^//${HOST.replace(/\./g, '\\.')}/:_authToken=`, 'm').test(fs.readFileSync(npmrc, 'utf8'));
  } catch {
    // no .npmrc
  }
  if (!hasAuth && !process.env.NPM_TOKEN) die('no registry auth: export NPM_TOKEN or run pf setup');
  if (!process.stdin.isTTY) die('publishing needs a terminal to confirm');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`Type ${bold(pkg.version)} to publish ${pkg.name} to ${REGISTRY}: `, resolve));
  rl.close();
  if (answer.trim() !== pkg.version) die('cancelled');
  const r = run('npm', ['publish', '--registry', REGISTRY]);
  if (r.status !== 0) die('npm publish failed');
  ok(`published ${pkg.name}@${pkg.version}`);
} else {
  const r = run('npm', ['publish', '--dry-run', '--registry', REGISTRY]);
  if (r.status !== 0) die('npm publish --dry-run failed');
  ok('dry run passed. Publish for real with: pnpm publish:cellars');
}
