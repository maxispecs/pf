import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { findDeployHelpers } from '../src/detect/helpers.js';
import { mkRepo } from './helpers.js';

const exec = (dir: string, file: string) => fs.chmodSync(path.join(dir, file), 0o755);

const TL = `#!/usr/bin/env bash
GWLOCAL=True
if [ -z "$GWHOME" ]; then export GWHOME=/x; fi
if [ "$1" = "deploy" ] || [ "$1" = "d" ]; then
  git push
fi
`;
const T = `#!/usr/bin/env bash
if [ -z "$GWHOME" ]; then echo no; exit 1; fi
if [ "$1" = "update" ]; then git pull; fi
`;
const AL = `#!/usr/bin/env bash
GWLOCAL=True
if [ "$1" = "cv" ] || [ "$1" = "deploy" ] || [ "$1" = "d" ]; then cmd="deploy"; fi
`;
const A_SH = `#!/usr/bin/env bash
. $GWHOME/services/arbiter/inc/boot.sh
if [ "$1" = "deploy" ] || [ "$1" = "d" ]; then cmd="deploy"; fi
sudo systemctl restart prefect-worker
`;

function repo(files: Record<string, string>): string {
  const dir = mkRepo(files);
  for (const f of Object.keys(files)) if (!f.includes('/') && files[f]!.startsWith('#!')) exec(dir, f);
  return dir;
}

test('triton: the local helper is found, the server helper without a deploy branch is not', () => {
  const found = findDeployHelpers(repo({ tl: TL, t: T, 'Readme.md': '# deploy it\n' }));
  assert.deepEqual(found.map((h) => h.file), ['tl']);
  assert.equal(found[0]!.local, true);
  assert.equal(found[0]!.branch, true);
});

test('arbiter: al ranks above a.sh, which is marked server only', () => {
  const found = findDeployHelpers(repo({ al: AL, 'a.sh': A_SH, 'deploy/arbiter.yaml': 'x: 1\n', 'AGENTS.md': 'deploy\n' }));
  assert.deepEqual(found.map((h) => h.file), ['al', 'a.sh']);
  assert.equal(found[0]!.serverOnly, false);
  assert.equal(found[1]!.serverOnly, true);
  assert.match(found[1]!.reasons.join(' '), /server only/);
});

test('files that are not executable scripts, hidden files, and folders named deploy are ignored', () => {
  const dir = mkRepo({ 'plain.sh': AL, '.hidden': AL, 'deploy/run': AL, 'bin.dat': 'deploy\n' });
  fs.chmodSync(path.join(dir, 'plain.sh'), 0o644);
  fs.chmodSync(path.join(dir, '.hidden'), 0o755);
  fs.chmodSync(path.join(dir, 'bin.dat'), 0o755);
  assert.deepEqual(findDeployHelpers(dir), []);
});
