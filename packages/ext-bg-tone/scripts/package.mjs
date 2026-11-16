#!/usr/bin/env node
// Build the extension and package it as bg-tone.vsix next to this package's package.json.
//
// This package has two manifests: package.json is the npm package (its version is the one `pnpm ver`
// bumps), extension/package.json is the VS Code manifest. The vsix is built from a staging folder
// whose manifest carries the npm version, so a version is only ever edited in one place.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`package: ${cmd} ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
};

const npmPkg = readJson('package.json');
const vsixName = npmPkg.pf.extension.vsix;
const manifest = { ...readJson('extension', 'package.json'), version: npmPkg.version };

run(process.execPath, ['esbuild.cjs'], root);

const stage = path.join(root, '.stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.cpSync(path.join(root, 'media'), path.join(stage, 'media'), { recursive: true });
fs.mkdirSync(path.join(stage, 'dist'));
fs.copyFileSync(path.join(root, 'dist', 'extension.js'), path.join(stage, 'dist', 'extension.js'));
for (const f of ['LICENSE', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(stage, f));

const vsce = path.join(root, 'node_modules', '.bin', 'vsce');
const out = path.join(root, vsixName);
fs.rmSync(out, { force: true });
run(vsce, ['package', '--no-dependencies', '--allow-missing-repository', '--out', out], stage);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`package: ${vsixName} (${manifest.name} ${manifest.version})`);
