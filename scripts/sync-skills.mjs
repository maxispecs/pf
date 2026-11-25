#!/usr/bin/env node
// Refresh this repo's own copies of the skill helpers from the skill packages that ship with pf.
//   node scripts/sync-skills.mjs [--dry-run]
// packages/skill-version and packages/skill-repo are the source of truth for the version CLI and the pnpm
// helper; pf reads them from there. The repo's own scripts/version.mjs and scripts/tasks.mjs are copies of
// them, so this repo can run `pnpm ver` and `pnpm ask` without pf.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

const FILES = [
  { from: 'packages/skill-version/skills/version/scripts/version.mjs', to: ['scripts/version.mjs'] },
  { from: 'packages/skill-repo/skills/pnpm/scripts/tasks.mjs', to: ['scripts/tasks.mjs'] },
];

let failed = false;
for (const f of FILES) {
  const src = path.join(root, f.from);
  if (!existsSync(src)) {
    console.error(`missing   ${f.from}`);
    failed = true;
    continue;
  }
  const text = readFileSync(src, 'utf8');
  for (const rel of f.to) {
    const dest = path.join(root, rel);
    const same = existsSync(dest) && readFileSync(dest, 'utf8') === text;
    if (!same && !dryRun) copyFileSync(src, dest);
    console.log(`${same ? 'current ' : dryRun ? 'would update' : 'updated '}  ${rel}  ${same ? '' : `<- ${f.from}`}`);
  }
}
process.exit(failed ? 1 : 0);
