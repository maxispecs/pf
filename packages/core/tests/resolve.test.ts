import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { candidates } from '@pulpfixer/kit/detect/resolve';
import { detectDocs } from '@pulpfixer/kit/detect/docs';
import { detectProduction, detectStaging } from '@pulpfixer/kit/detect/deploy';
import { detectedEntries } from '../src/commands/init.js';
import { json, lines, mkRepo } from './helpers.js';

test('resolution order: pf.json, then repo scripts, then stack defaults', () => {
  const dir = mkRepo({
    '.git/HEAD': '',
    'package.json': json({ scripts: { dev: 'vite' } }),
    Makefile: 'dev:\n\techo\n',
    'compose.yaml': 'services: {}\n',
    'pf.json': json({ commands: { dev: { run: './run.sh', description: 'x' } } }),
  });
  const ctx = buildContext(dir);
  assert.deepEqual(lines(candidates('dev', ctx)), ['./run.sh', 'npm run dev', 'make dev', 'docker compose up']);
  assert.equal(candidates('dev', ctx)[0]!.source, 'pf.json');
});

test('a script beats a default of another stack', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'go.mod': 'module x\n', Makefile: 'run:\n\techo\n' });
  assert.deepEqual(lines(candidates('dev', buildContext(dir))), ['make run', 'go run .']);
});

test('pf.json cwd is resolved against the repo root', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'pf.json': json({ commands: { test: { run: 'npm t', cwd: 'sub' } } }), 'sub/x': '' });
  const c = candidates('test', buildContext(dir))[0]!;
  assert.ok(c.cmd.cwd!.endsWith('/sub'));
});

test('a subproject inside a repo resolves against itself', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { dev: 'root' } }), 'apps/web/package.json': json({ scripts: { dev: 'web' } }) });
  const ctx = buildContext(`${dir}/apps/web`);
  assert.equal(ctx.repo!.root, dir);
  assert.equal(ctx.workdir, `${dir}/apps/web`);
  assert.equal(candidates('dev', ctx)[0]!.cmd.cwd, `${dir}/apps/web`);
});

test('docs: root script, docs package, framework, static generators', () => {
  const root = detectDocs(buildContext(mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'docs:dev': 'x' } }), 'pnpm-lock.yaml': '' })));
  assert.deepEqual(lines(root), ['pnpm run docs:dev']);
  const pkg = detectDocs(buildContext(mkRepo({ '.git/HEAD': '', 'package.json': '{}', 'apps/docs/package.json': json({ dependencies: { nextra: '4' }, scripts: { dev: 'next dev' } }) })));
  assert.equal(pkg[0]!.source, 'apps/docs (nextra)');
  assert.ok(pkg[0]!.cmd.cwd!.endsWith('apps/docs'));
  assert.deepEqual(lines(detectDocs(buildContext(mkRepo({ '.git/HEAD': '', 'mkdocs.yml': 'site_name: x\n' })))), ['mkdocs serve']);
  assert.deepEqual(lines(detectDocs(buildContext(mkRepo({ '.git/HEAD': '', 'docs/.vitepress/config.ts': '' })))), ['npx vitepress dev docs']);
  assert.deepEqual(lines(detectDocs(buildContext(mkRepo({ '.git/HEAD': '', 'book.toml': '' })))), ['mdbook serve']);
  assert.deepEqual(detectDocs(buildContext(mkRepo({ '.git/HEAD': '', 'package.json': '{}' }))), []);
});

test('staging: script wins, then workflow, then platform configs', () => {
  const script = detectStaging(buildContext(mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { 'deploy:staging': 'x' } }), 'vercel.json': '{}' })));
  assert.deepEqual(lines(script.steps), ['npm run deploy:staging']);
  const wf = detectStaging(buildContext(mkRepo({ '.git/HEAD': '', '.github/workflows/deploy-staging.yml': 'on:\n  workflow_dispatch:\n' })));
  assert.deepEqual(lines(wf.steps), ['gh workflow run deploy-staging.yml']);
  const fb = detectStaging(buildContext(mkRepo({ '.git/HEAD': '', 'firebase.json': '{}', '.firebaserc': json({ projects: { staging: 'p-stg' } }) })));
  assert.deepEqual(lines(fb.steps), ['firebase deploy --project staging']);
  const noAlias = detectStaging(buildContext(mkRepo({ '.git/HEAD': '', 'firebase.json': '{}', '.firebaserc': json({ projects: { default: 'p' } }) })));
  assert.equal(noAlias.steps.length, 0);
  assert.match(noAlias.skipped[0]!, /no "staging" alias/);
  const fly = detectStaging(buildContext(mkRepo({ '.git/HEAD': '', 'fly.staging.toml': '' })));
  assert.deepEqual(lines(fly.steps), ['fly deploy --config fly.staging.toml']);
});

test('staging never targets production', () => {
  const plan = detectStaging(buildContext(mkRepo({ '.git/HEAD': '', 'vercel.json': '{}', 'netlify.toml': '', 'wrangler.toml': '[env.staging]\n' })));
  for (const l of lines(plan.steps)) assert.doesNotMatch(l, /--prod|production/);
  assert.equal(plan.steps.length, 3);
});

test('init writes the first detected command per task and keeps existing entries', () => {
  const dir = mkRepo({ '.git/HEAD': '', 'package.json': json({ scripts: { dev: 'x', build: 'y' } }), 'pnpm-lock.yaml': '' });
  const ctx = buildContext(dir);
  const added = detectedEntries(ctx, { build: { run: 'custom' } });
  assert.equal(added.dev!.run, 'pnpm run dev');
  assert.equal(added.dev!.group, 'Develop');
  assert.ok(!('build' in added));
  assert.equal(added.install!.run, 'pnpm install');
});

test('staging and production: a composer script or a local ./a command counts, -y only when the script takes it', () => {
  const cli = {
    a: '',
    'cli/run': '',
    'cli/commands/deploy/staging.sh': '# usage: ./a deploy:staging -y\n',
    'cli/commands/deploy/production.sh': '# usage: ./a deploy:production\n',
  };
  const stg = detectStaging(buildContext(mkRepo({ '.git/HEAD': '', ...cli })));
  assert.deepEqual(lines(stg.steps), ['./a deploy:staging -y']);
  assert.equal(stg.steps[0]!.source, './a deploy:staging');
  assert.deepEqual(lines(detectProduction(buildContext(mkRepo({ '.git/HEAD': '', ...cli }))).steps), ['./a deploy:production']);
  const composer = json({ scripts: { 'deploy:staging': 'x', 'deploy:production': 'y' } });
  assert.deepEqual(lines(detectStaging(buildContext(mkRepo({ '.git/HEAD': '', 'composer.json': composer, ...cli }))).steps), ['composer run deploy:staging']);
  assert.deepEqual(lines(detectProduction(buildContext(mkRepo({ '.git/HEAD': '', 'composer.json': composer }))).steps), ['composer run deploy:production']);
  assert.equal(detectProduction(buildContext(mkRepo({ '.git/HEAD': '', 'composer.json': '{}', 'public/index.php': '' }))).steps.length, 0);
});
