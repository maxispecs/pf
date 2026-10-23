#!/usr/bin/env node
// Run every package's tests (packages/*/tests/*.test.ts) in one node test run.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const pkg of readdirSync(path.join(root, 'packages'))) {
  const dir = path.join(root, 'packages', pkg, 'tests');
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.test.ts')) files.push(path.join(dir, f));
}
const r = spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
