#!/usr/bin/env node
// Clean dist and compile every package with tsc, in dependency order (kit, plugins, core), then bundle the
// suite extension and package its .vsix (`pf sys apply suite` installs that file).
import { rmSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
const PACKAGES = ['kit', 'plugin-aws', 'plugin-csv', 'plugin-db', 'plugin-io', 'plugin-pdf', 'plugin-system', 'plugin-yubikey', 'db-postgres', 'db-mysql', 'pulpfixer'];

for (const name of PACKAGES) {
  const dir = path.join(root, 'packages', name);
  rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
  const r = spawnSync(tsc, ['-p', dir], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`built packages/${name}`);
}
const bin = path.join(root, 'packages', 'pulpfixer', 'dist', 'bin', 'pf.js');
if (!existsSync(bin)) {
  console.error('build: packages/pulpfixer/dist/bin/pf.js was not produced');
  process.exit(1);
}
chmodSync(bin, 0o755);

const pkg = spawnSync(process.execPath, [path.join(root, 'packages', 'ext-bg-tone', 'scripts', 'package.mjs')], { cwd: root, stdio: 'inherit' });
if (pkg.status !== 0) process.exit(pkg.status ?? 1);
console.log('built packages/ext-bg-tone (bg-tone.vsix)');
