import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { allCommands } from '../src/commands/index.js';
import { defaultScratchName, NEW_KINDS, newCommand, scratchNameProblem, templateOfKind } from '../src/commands/new.js';
import { shellPath } from '../src/commands/template.js';
import { entriesFor } from '../src/menu.js';
import { mkRepo } from './helpers.js';

/** Run `fn` with stdout / stderr captured and no terminal. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  const tty = [process.stdin.isTTY, process.stderr.isTTY];
  const set = (s: NodeJS.ReadStream | NodeJS.WriteStream, v: boolean | undefined) => Object.defineProperty(s, 'isTTY', { value: v, configurable: true, writable: true });
  set(process.stdin, false);
  set(process.stderr, false);
  process.stdout.write = ((s: string | Uint8Array) => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (err.push(String(s)), true)) as typeof process.stderr.write;
  try {
    return { code: await fn(), stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    set(process.stdin, tty[0]);
    set(process.stderr, tty[1]);
  }
}

const run = (cwd: string, ...args: string[]) => capture(() => newCommand.run(buildContext(cwd), args));

test('pf new is a command and a menu entry', () => {
  assert.ok(allCommands().some((c) => c.name === 'new'));
  assert.ok(entriesFor(buildContext(mkRepo())).some((e) => e.name === 'new'));
  assert.deepEqual(NEW_KINDS.map((k) => k.kind), ['query', 'pipe', 'scratch']);
});

test('the kinds map to their templates, scratch has none', () => {
  assert.equal(templateOfKind('query'), 'query-package');
  assert.equal(templateOfKind('pipe'), 'pipe-package');
  assert.equal(templateOfKind('scratch'), null);
});

test('scratch names: lowercase, digits and dashes; the default is dated', () => {
  assert.equal(scratchNameProblem('try-1'), null);
  for (const bad of ['', 'Try', '-x', 'a b', 'a/b', '../x', 'a_b']) assert.ok(scratchNameProblem(bad), bad);
  assert.equal(defaultScratchName(new Date(2026, 10, 20)), 'scratch-20261120');
  assert.equal(scratchNameProblem(defaultScratchName()), null);
});

test('pf new without a terminal prints usage, an unknown kind is a usage error', async () => {
  const bare = await run(mkRepo());
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /pf new scratch/);
  const bad = await run(mkRepo(), 'nope');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown kind "nope"/);
  assert.equal((await run(mkRepo(), 'help')).code, 0);
});

test('pf new scratch makes an empty folder in the repos folder; --dry-run and conflicts write nothing', async () => {
  const cwd = mkRepo();
  const repos = path.join(mkRepo(), 'not', 'yet');
  process.env.PF_REPOS_DIR = repos;
  try {
    const dry = await run(cwd, 'scratch', 'try-1', '--dry-run');
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stderr, /Would create .*try-1/);
    assert.equal(fs.existsSync(repos), false, 'a dry run creates nothing, not even the repos folder');

    const r = await run(cwd, 'scratch', 'try-1', '--no-git', '--no-repo');
    assert.equal(r.code, 0, r.stderr);
    const target = path.join(repos, 'try-1');
    assert.ok(fs.statSync(target).isDirectory());
    assert.deepEqual(fs.readdirSync(target), []);
    assert.ok(r.stderr.includes(`cd ${shellPath(target)}`), r.stderr);

    // An existing empty folder is fine, one with files is not.
    assert.equal((await run(cwd, 'scratch', 'try-1', '--no-git', '--no-repo')).code, 0);
    fs.writeFileSync(path.join(target, 'x.txt'), 'x');
    const again = await run(cwd, 'scratch', 'try-1', '--no-git', '--no-repo');
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists and is not empty/);

    const into = await run(cwd, 'scratch', 'here', '--no-git', '--no-repo', '--dir', 'a/b');
    assert.equal(into.code, 0, into.stderr);
    assert.ok(fs.existsSync(path.join(cwd, 'a', 'b')));
    assert.match(into.stderr, /cd a[\\/]b\b/);

    assert.equal((await run(cwd, 'scratch', 'Bad Name')).code, 2);
    assert.equal((await run(cwd, 'scratch')).code, 2, 'a name is needed without a terminal');
    assert.equal((await run(cwd, 'scratch', 'x', 'extra')).code, 2);
  } finally {
    delete process.env.PF_REPOS_DIR;
  }
});

test('pf new scratch runs git init in the new folder', async () => {
  const cwd = mkRepo();
  const repos = mkRepo();
  process.env.PF_REPOS_DIR = repos;
  try {
    const r = await run(cwd, 'scratch', 'with-git', '--no-repo');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(repos, 'with-git', '.git')) || fs.existsSync(path.join(repos, '.git')), 'a git repo is there (or the repos folder already is one)');
  } finally {
    delete process.env.PF_REPOS_DIR;
  }
});

test('pf new query and pipe hand their arguments to pf template apply', async () => {
  const home = mkRepo();
  process.env.PF_HOME = home;
  try {
    for (const [kind, template] of [['query', 'query-package'], ['pipe', 'pipe-package']] as const) {
      const r = await run(mkRepo(), kind, 'demo', '--offline');
      assert.notEqual(r.code, 0, 'nothing is cached, so an offline run cannot find the template');
      assert.match(r.stderr, new RegExp(template), r.stderr);
    }
  } finally {
    delete process.env.PF_HOME;
  }
});
