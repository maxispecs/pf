#!/usr/bin/env node
// Refresh the skill helpers pf bundles (and this repo's own copies) from a skills checkout.
//   node scripts/sync-skills.mjs [--from <skills dir>] [--dry-run]
// The skills dir holds ver/ and pnpm/. Default: PF_SKILLS_DIR, else the checkout ~/.claude/skills/ver links into.
import { copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fromIdx = args.indexOf('--from');

function skillsDir() {
  if (fromIdx !== -1) return path.resolve(args[fromIdx + 1] ?? '.');
  if (process.env.PF_SKILLS_DIR) return path.resolve(process.env.PF_SKILLS_DIR);
  const ver = path.join(os.homedir(), '.claude', 'skills', 'ver');
  return existsSync(ver) ? path.dirname(realpathSync(ver)) : null;
}

const FILES = [
  { from: 'ver/scripts/version.mjs', to: ['packages/pulpfixer/assets/version.mjs', 'scripts/version.mjs'] },
  { from: 'pnpm/scripts/tasks.mjs', to: ['packages/pulpfixer/assets/tasks.mjs', 'scripts/tasks.mjs'] },
];

const dir = skillsDir();
if (!dir) {
  console.error('error: no skills checkout found; pass --from <dir> or set PF_SKILLS_DIR');
  process.exit(1);
}
let failed = false;
for (const f of FILES) {
  const src = path.join(dir, f.from);
  if (!existsSync(src)) {
    console.error(`missing   ${src}`);
    failed = true;
    continue;
  }
  const text = readFileSync(src, 'utf8');
  for (const rel of f.to) {
    const dest = path.join(root, rel);
    const same = existsSync(dest) && readFileSync(dest, 'utf8') === text;
    if (!same && !dryRun) copyFileSync(src, dest);
    console.log(`${same ? 'current ' : dryRun ? 'would update' : 'updated '}  ${rel}  ${same ? '' : `<- ${src}`}`);
  }
}
process.exit(failed ? 1 : 0);
