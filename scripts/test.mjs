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
// Plain text whatever terminal runs this (the dev cycle runs it in one): tests that check colors set their own env.
const env = { ...process.env, NO_COLOR: '1' };
delete env.FORCE_COLOR;
const r = spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit', env });
process.exit(r.status ?? 1);
