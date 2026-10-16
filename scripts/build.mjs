#!/usr/bin/env node
// Clean dist, compile with tsc, make the bin executable.
import { rmSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
const r = spawnSync(tsc, [], { cwd: root, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const bin = path.join(root, 'dist', 'bin', 'pf.js');
if (!existsSync(bin)) {
  console.error('build: dist/bin/pf.js was not produced');
  process.exit(1);
}
chmodSync(bin, 0o755);
console.log('built dist/bin/pf.js');
