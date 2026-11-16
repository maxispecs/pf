import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allCommands } from '../src/commands/index.js';
import { planPush, resolvePrimary, secondaryArgs, type PushFacts } from '../src/gitpush.js';
import { entriesFor } from '../src/menu.js';
import { listActions } from '../src/commands/actions.js';
import { buildContext } from '@pulpfixer/kit/context';
import { mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function pf(cwd: string, ...args: string[]) {
  const env = { ...gitEnv, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_NO_TRAVOLTA: '1', PF_HOME: mkRepo({}) };
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** A checkout on `main` with one commit, and an `origin` bare remote that has nothing yet. */
function mkCheckout() {
  const dir = mkRepo({ 'a.txt': 'a\n' });
  const bare = (name: string) => {
    const p = path.join(mkRepo({}), `${name}.git`);
    git(dir, 'init', '--bare', '-b', 'main', p);
    return p;
  };
  git(dir, 'init', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'one');
  const origin = bare('origin');
  git(dir, 'remote', 'add', 'origin', origin);
  return { dir, origin, bare };
}

const head = (bare: string, branch = 'main'): string | null => {
  const r = spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', branch], { encoding: 'utf8', env: gitEnv });
  return r.status === 0 ? r.stdout.trim() : null;
};

const facts = (over: Partial<PushFacts> = {}): PushFacts => ({ config: {}, branch: 'main', upstreamRemote: 'origin', remotes: ['origin'], args: [], secondary: true, ...over });

test('planPush: the first push of a branch sets its upstream, on the primary only', () => {
  const first = planPush(facts({ upstreamRemote: undefined, config: { secondary: ['backup'] }, remotes: ['origin', 'backup'] }));
  assert.ok(first.ok);
  assert.deepEqual(first.steps.map((s) => s.argv), [['push', 'origin', '-u', 'HEAD'], ['push', 'backup']]);
  const own = planPush(facts({ upstreamRemote: undefined, args: ['--set-upstream'] }));
  assert.ok(own.ok);
  assert.deepEqual(own.steps[0]!.argv, ['push', 'origin', 'HEAD', '--set-upstream']);
  const refspec = planPush(facts({ upstreamRemote: undefined, args: ['HEAD:refs/heads/x'] }));
  assert.ok(refspec.ok);
  assert.deepEqual(refspec.steps[0]!.argv, ['push', 'origin', 'HEAD:refs/heads/x']);
  const local = planPush(facts({ upstreamRemote: '.' }));
  assert.ok(local.ok);
  assert.deepEqual(local.steps[0]!.argv, ['push', 'origin']);
});

test('the primary is the configured remote, else the branch upstream, else origin', () => {
  assert.equal(resolvePrimary({ primary: 'gh' }, 'up'), 'gh');
  assert.equal(resolvePrimary({}, 'up'), 'up');
  assert.equal(resolvePrimary({}, '.'), 'origin');
  assert.equal(resolvePrimary({}), 'origin');
});

test('planPush: nothing configured pushes the primary only', () => {
  const p = planPush(facts({ args: ['--tags'] }));
  assert.ok(p.ok);
  assert.deepEqual(p.steps, [{ remote: 'origin', role: 'primary', argv: ['push', 'origin', '--tags'] }]);
});

test('planPush: secondaries follow the primary, never get -u, and --no-secondary drops them', () => {
  const f = facts({ config: { secondary: ['backup', 'origin'] }, remotes: ['origin', 'backup'], args: ['-u', '--tags'] });
  const p = planPush(f);
  assert.ok(p.ok);
  assert.deepEqual(p.steps.map((s) => s.argv), [['push', 'origin', '-u', '--tags'], ['push', 'backup', '--tags']]);
  const only = planPush({ ...f, secondary: false });
  assert.ok(only.ok);
  assert.equal(only.steps.length, 1);
  assert.deepEqual(secondaryArgs(['--set-upstream', '-f']), ['-f']);
});

test('planPush: a missing remote, or a detached HEAD, is an error with a hint', () => {
  const noPrimary = planPush(facts({ remotes: [] }));
  assert.ok(!noPrimary.ok && /git remote add origin/.test(noPrimary.error));
  const missing = planPush(facts({ config: { secondary: ['backup'] } }));
  assert.ok(!missing.ok && /"backup"/.test(missing.error) && /pf git backup add/.test(missing.error));
  const detached = planPush(facts({ branch: null }));
  assert.ok(!detached.ok && /detached/.test(detached.error));
  assert.ok(planPush(facts({ branch: null, args: ['HEAD:refs/heads/x'] })).ok);
});

test('pf gp with nothing configured pushes the primary remote only', () => {
  const { dir, origin } = mkCheckout();
  const r = pf(dir, 'gp');
  assert.equal(r.code, 0, r.out);
  assert.equal(head(origin), git(dir, 'rev-parse', 'main'));
  assert.ok(!fs.existsSync(path.join(dir, '.pf')));
});

test('pf git backup add sets up a backup remote, and pf gp pushes to both', () => {
  const { dir, origin, bare } = mkCheckout();
  const backup = bare('backup');
  const add = pf(dir, 'git', 'backup', 'add', 'backup', backup);
  assert.equal(add.code, 0, add.out);
  assert.equal(git(dir, 'remote', 'get-url', 'backup'), backup);
  assert.equal(fs.readFileSync(path.join(dir, '.pf', '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.pf', 'config.json'), 'utf8')), { git: { push: { secondary: ['backup'] } } });
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the .pf folder is never shown to git');

  const show = pf(dir, 'git');
  assert.equal(show.code, 0, show.out);
  assert.match(show.out, /primary:\s+origin/);
  assert.match(show.out, /backup:\s+backup/);

  const r = pf(dir, 'gp');
  assert.equal(r.code, 0, r.out);
  const main = git(dir, 'rev-parse', 'main');
  assert.equal(head(origin), main);
  assert.equal(head(backup), main);

  // A new commit and a new branch: the secondary gets the same push as the primary, nothing else.
  git(dir, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'two');
  assert.equal(pf(dir, 'gp').code, 0);
  assert.equal(head(origin, 'feature'), git(dir, 'rev-parse', 'feature'));
  assert.equal(head(backup, 'feature'), git(dir, 'rev-parse', 'feature'));
});

test('pf gp --dry-run and --no-secondary', () => {
  const { dir, origin, bare } = mkCheckout();
  const backup = bare('backup');
  pf(dir, 'git', 'backup', 'add', 'backup', backup);
  const dry = pf(dir, 'gp', '--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /git push origin/);
  assert.match(dry.out, /git push backup/);
  assert.equal(head(origin), null);
  assert.equal(pf(dir, 'gp', '--no-secondary').code, 0);
  assert.notEqual(head(origin), null);
  assert.equal(head(backup), null);
});

test('a failing secondary does not stop the others, and the exit code says so', () => {
  const { dir, origin, bare } = mkCheckout();
  const backup = bare('backup');
  git(dir, 'remote', 'add', 'broken', path.join(mkRepo({}), 'does-not-exist.git'));
  for (const name of ['broken']) assert.equal(pf(dir, 'git', 'backup', 'add', name).code, 0);
  assert.equal(pf(dir, 'git', 'backup', 'add', 'backup', backup).code, 0);
  const r = pf(dir, 'gp');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /push failed for broken/);
  assert.equal(head(origin), git(dir, 'rev-parse', 'main'));
  assert.equal(head(backup), git(dir, 'rev-parse', 'main'));
});

test('a failing primary push stops before the secondary remotes', () => {
  const { dir, bare } = mkCheckout();
  const backup = bare('backup');
  git(dir, 'remote', 'set-url', 'origin', path.join(mkRepo({}), 'does-not-exist.git'));
  pf(dir, 'git', 'backup', 'add', 'backup', backup);
  const r = pf(dir, 'gp');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /backup remotes were not pushed/);
  assert.equal(head(backup), null);
});

test('pf git backup and primary: add, remove and the refusals', () => {
  const { dir, bare } = mkCheckout();
  const backup = bare('backup');
  assert.equal(pf(dir, 'git', 'backup', 'add', 'origin').code, 1, 'the primary cannot be its own secondary');
  assert.equal(pf(dir, 'git', 'backup', 'add', 'nope').code, 1, 'an unknown remote needs a URL');
  assert.equal(pf(dir, 'git', 'backup', 'add', '--force').code, 1);
  assert.equal(pf(dir, 'git', 'backup', 'add', 'backup', backup, '--dry-run').code, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.pf')), 'a dry run writes nothing');
  assert.throws(() => git(dir, 'remote', 'get-url', 'backup'));
  assert.equal(pf(dir, 'git', 'backup', 'add', 'backup', backup).code, 0);
  assert.equal(pf(dir, 'git', 'primary', 'backup').code, 0);
  const cfg = () => JSON.parse(fs.readFileSync(path.join(dir, '.pf', 'config.json'), 'utf8')).git?.push;
  assert.deepEqual(cfg(), { primary: 'backup' }, 'a new primary leaves the secondary list');
  assert.equal(pf(dir, 'git', 'primary', '--unset').code, 0);
  assert.equal(cfg(), undefined);
  assert.equal(pf(dir, 'git', 'backup', 'add', 'backup').code, 0);
  assert.equal(pf(dir, 'git', 'backup', 'remove', 'backup').code, 0);
  assert.equal(cfg(), undefined);
  assert.equal(git(dir, 'remote', 'get-url', 'backup'), backup, 'the git remote itself stays');
  assert.equal(pf(dir, 'git', 'backup', 'remove', 'backup').code, 1);
  assert.equal(pf(dir, 'git', 'backup', 'bogus').code, 2);
});

test('pf gp outside a git repo fails cleanly', () => {
  assert.equal(pf(mkRepo({ 'pulpfixer.json': '{}' }), 'gp').code, 1);
});

test('git and gp are commands, and the repo gets a git:push action', () => {
  const names = allCommands().map((c) => c.name);
  assert.ok(names.includes('git') && names.includes('gp') && !names.includes('git-push'));
  const { dir } = mkCheckout();
  const ctx = buildContext(dir);
  const entryNames = entriesFor(ctx).map((e) => e.name);
  assert.ok(entryNames.includes('git push') && entryNames.includes('git'));
  const action = listActions(ctx).find((a) => a.id === 'git:push');
  assert.deepEqual(action?.argv, ['git', 'push']);
  assert.equal(action?.featured, false);
  assert.equal(action?.icon, 'repo-push');
  const noRemote = mkRepo({});
  git(noRemote, 'init', '-b', 'main');
  const noRemoteNames = entriesFor(buildContext(noRemote)).map((e) => e.name);
  assert.ok(!noRemoteNames.includes('git push'), 'nothing to push without a remote');
  assert.ok(noRemoteNames.includes('git'), 'but the git menu can still add one');
});

test('pf git push is what pf gp runs, and pf git without a terminal prints the remotes', () => {
  const { dir, origin, bare } = mkCheckout();
  const backup = bare('backup');
  assert.equal(pf(dir, 'git', 'backup', 'add', 'backup', backup).code, 0);
  const dry = pf(dir, 'git', 'push', '--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /git push origin/);
  assert.match(dry.out, /git push backup/);
  const r = pf(dir, 'git', 'push');
  assert.equal(r.code, 0, r.out);
  assert.equal(head(origin), git(dir, 'rev-parse', 'main'));
  assert.equal(head(backup), git(dir, 'rev-parse', 'main'));
  const show = pf(dir, 'git');
  assert.equal(show.code, 0, show.out);
  assert.match(show.out, /primary:\s+origin/);
  assert.match(show.out, /backup:\s+backup/);
  assert.equal(pf(dir, 'git', 'status').code, 0);
});

test('pf git: unknown subcommands, and a backup remote needs a terminal or arguments', () => {
  const { dir } = mkCheckout();
  assert.equal(pf(dir, 'git', 'bogus').code, 2);
  assert.equal(pf(dir, 'git', 'backup').code, 2, 'the wizard needs a terminal');
  assert.equal(pf(dir, 'git', 'primary').code, 1, 'no remote named and no terminal');
  assert.equal(pf(dir, 'git', 'backup', 'add', 'x', '-oProxyCommand=evil').code, 1, 'a URL cannot be an option');
  assert.equal(pf(mkRepo({ 'pulpfixer.json': '{}' }), 'git', 'status').code, 1);
});
