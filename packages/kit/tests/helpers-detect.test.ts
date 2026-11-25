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

const GENETICS_MIGRATIONS = `#!/usr/bin/env bash

# cd /var/www/genetics/bitbucket/genetics || return 100
# /usr/local/bin/knex migrate:latest

echo "deploy migrations legacy script"
`;
const APPSPEC = `version: 0.0
os: linux
files:
  - source: /
    destination: /var/www/genetics
hooks:
  BeforeInstall:
    - location: deploy_before.sh
  AfterInstall:
    - location: deploy_migrations.sh
      timeout: 30000
      runas: ubuntu
    - location: deploy_clear_cake_cache.sh
`;
const MIGRATE = `#!/usr/bin/env bash
if [[ "$1" == "all" ]]; then
  knex migrate:latest
fi
`;
const DEV = `#!/usr/bin/env bash
case "$1" in
  "vault") composer docker:vault & ;;
  *) composer docker:start & ;;
esac
`;

test('genetics: deploy_migrations.sh is a stub, one step and a CodeDeploy hook, so nothing is eligible', () => {
  const found = findDeployHelpers(repo({ 'deploy_migrations.sh': GENETICS_MIGRATIONS, 'appspec.yml': APPSPEC, 'migrate.sh': MIGRATE, dev: DEV }));
  assert.deepEqual(found.map((h) => h.file), ['deploy_migrations.sh']);
  const h = found[0]!;
  assert.equal(h.eligible, false);
  assert.equal(h.role, 'step');
  assert.equal(h.stub, true);
  assert.equal(h.hook, 'appspec.yml AfterInstall');
  assert.match(h.rejected!, /one step of a deploy \(migrations\)/);
  assert.match(h.rejected!, /appspec\.yml AfterInstall/);
  assert.match(h.rejected!, /does nothing/);
});

test('a script that only mentions deploy, with no deploy branch or name, is not a candidate', () => {
  const found = findDeployHelpers(repo({ notes: '#!/usr/bin/env bash\n# we deploy with CI\necho "deploy happens in the pipeline"\nls\n', 'build.sh': '#!/bin/sh\nnpm run build # then deploy\n' }));
  assert.deepEqual(found, []);
});

test('a case label counts as the deploy branch, comments do not', () => {
  const real = findDeployHelpers(repo({ run: '#!/bin/bash\ncase "$1" in\n  d|deploy)\n    git push origin main\n    ;;\nesac\n' }));
  assert.equal(real[0]?.branch, true);
  assert.equal(real[0]?.eligible, true);
  const commented = findDeployHelpers(repo({ run: '#!/bin/bash\n# if [ "$1" = "deploy" ]; then\ngit status\n' }));
  assert.deepEqual(commented, []);
});

test('deploy-staging.sh with real commands is a whole deploy; deploy-api.sh and deploy_cache.sh are parts', () => {
  const body = '#!/bin/bash\naws s3 sync build s3://bucket\n';
  const found = findDeployHelpers(repo({ 'deploy-staging.sh': body, 'deploy.sh': body, 'deploy_cache.sh': body, 'deploy-api.sh': body }));
  assert.deepEqual(found.filter((h) => h.eligible).map((h) => h.file).sort(), ['deploy-staging.sh', 'deploy.sh']);
  const cache = found.find((h) => h.file === 'deploy_cache.sh')!;
  assert.equal(cache.role, 'step');
  assert.match(cache.rejected!, /\(cache\)/);
  assert.equal(found.find((h) => h.file === 'deploy-api.sh')!.eligible, false);
  assert.equal(found.at(-1)!.eligible, false, 'rejected ones sort last');
});

test('a live server path makes a helper server only; GWLOCAL keeps it local', () => {
  const server = findDeployHelpers(repo({ 'deploy.sh': '#!/bin/bash\ncd /var/www/app && git pull\n' }));
  assert.equal(server[0]!.serverOnly, true);
  assert.equal(server[0]!.eligible, false);
  const commented = findDeployHelpers(repo({ 'deploy.sh': '#!/bin/bash\n# cd /var/www/app\ngit push\n' }));
  assert.equal(commented[0]!.serverOnly, false);
  assert.equal(commented[0]!.eligible, true);
  const local = findDeployHelpers(repo({ tl: '#!/bin/bash\nGWLOCAL=True\nif [ "$1" = "d" ]; then rsync -a . /srv/app; fi\n' }));
  assert.equal(local[0]!.serverOnly, false);
  assert.equal(local[0]!.eligible, true);
});

test('triton and arbiter: al and tl stay eligible, a.sh is rejected as server only', () => {
  const found = findDeployHelpers(repo({ al: AL, tl: TL, 'a.sh': A_SH }));
  assert.deepEqual(found.filter((h) => h.eligible).map((h) => h.file).sort(), ['al', 'tl']);
  const a = found.find((h) => h.file === 'a.sh')!;
  assert.equal(a.eligible, false);
  assert.match(a.rejected!, /server/);
});
