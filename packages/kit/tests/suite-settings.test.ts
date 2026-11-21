import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { userConfigPath } from '../src/config.js';
import { expandHome, newRepoPath, reposDir, setSuiteSetting, shortHome, suiteSetting, suiteSettings, unsetSuiteSetting } from '../src/suite-settings.js';

/** Run with PF_HOME in a temp folder and PF_REPOS_DIR unset (or set to `repos`). */
function sandbox<T>(fn: (home: string) => T, repos?: string): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-suite-settings-'));
  const prev = { h: process.env.PF_HOME, r: process.env.PF_REPOS_DIR };
  process.env.PF_HOME = home;
  if (repos === undefined) delete process.env.PF_REPOS_DIR;
  else process.env.PF_REPOS_DIR = repos;
  try {
    return fn(home);
  } finally {
    if (prev.h === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev.h;
    if (prev.r === undefined) delete process.env.PF_REPOS_DIR;
    else process.env.PF_REPOS_DIR = prev.r;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('expandHome and shortHome', () => {
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('~/dev', '/h'), path.join('/h', 'dev'));
  assert.equal(expandHome('/x/y', '/h'), '/x/y');
  assert.equal(expandHome('rel', '/h'), 'rel');
  assert.equal(shortHome('/h/dev/x', '/h'), `~${path.sep}dev${path.sep}x`);
  assert.equal(shortHome('/h', '/h'), '~');
  assert.equal(shortHome('/elsewhere/x', '/h'), '/elsewhere/x');
  assert.equal(shortHome('/hx/dev', '/h'), '/hx/dev', 'a folder that only starts with the same letters is not under home');
});

test('reposDir is ~/dev by default, then the saved value, then PF_REPOS_DIR', () => {
  sandbox(() => {
    const first = suiteSetting('reposDir')!;
    assert.deepEqual([first.value, first.resolved, first.default, first.source], ['~/dev', path.join(os.homedir(), 'dev'), '~/dev', 'default']);
    assert.equal(reposDir(), path.join(os.homedir(), 'dev'));
    const r = setSuiteSetting('reposDir', '  ~/code/  ');
    assert.deepEqual(r, { ok: true, value: '~/code' });
    assert.equal(suiteSetting('reposDir')!.source, 'config');
    assert.equal(reposDir(), path.join(os.homedir(), 'code'));
  });
  const abs = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-repos-env-'));
  sandbox(() => {
    setSuiteSetting('reposDir', '~/code');
    assert.equal(suiteSetting('reposDir')!.source, 'env');
    assert.equal(reposDir(), abs);
  }, abs);
  fs.rmSync(abs, { recursive: true, force: true });
});

test('set refuses a relative path, ~user and a file; an absolute path that does not exist yet is fine', () => {
  sandbox((home) => {
    for (const bad of ['dev', './dev', '', '   ', '~bob/dev']) {
      const r = setSuiteSetting('reposDir', bad);
      assert.equal(r.ok, false, bad);
      assert.equal((r as { kind: string }).kind, 'invalid', bad);
    }
    const file = path.join(home, 'a-file');
    fs.writeFileSync(file, 'x');
    assert.match((setSuiteSetting('reposDir', file) as { error: string }).error, /not a folder/);
    const later = path.join(home, 'not', 'yet');
    assert.deepEqual(setSuiteSetting('reposDir', later), { ok: true, value: later });
    assert.equal(fs.existsSync(later), false, 'setting it creates nothing');
    assert.equal(suiteSetting('reposDir')!.value, later);
  });
});

test('an unknown key is refused, and a prototype key is not a setting', () => {
  sandbox(() => {
    assert.equal((setSuiteSetting('nope', 'x') as { kind: string }).kind, 'unknown');
    assert.equal((unsetSuiteSetting('nope') as { kind: string }).kind, 'unknown');
    assert.equal(suiteSetting('nope'), undefined);
    assert.equal(suiteSetting('constructor'), undefined);
    assert.equal((setSuiteSetting('__proto__', '/x') as { kind: string }).kind, 'unknown');
  });
});

test('set and unset keep every other key of config.json', () => {
  sandbox(() => {
    fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
    fs.writeFileSync(userConfigPath(), JSON.stringify({ agent: 'claude', plugins: { aws: { exchange: { bucket: 'b' } }, suite: { other: 1 } } }));
    assert.equal(setSuiteSetting('reposDir', '~/code').ok, true);
    const after = JSON.parse(fs.readFileSync(userConfigPath(), 'utf8'));
    assert.deepEqual(after, { agent: 'claude', plugins: { aws: { exchange: { bucket: 'b' } }, suite: { other: 1, reposDir: '~/code' } } });
    const r = unsetSuiteSetting('reposDir');
    assert.deepEqual(r, { ok: true, value: '~/dev' });
    assert.deepEqual(JSON.parse(fs.readFileSync(userConfigPath(), 'utf8')), { agent: 'claude', plugins: { aws: { exchange: { bucket: 'b' } }, suite: { other: 1 } } });
    assert.equal(suiteSetting('reposDir')!.source, 'default');
  });
});

test('an unusable saved value falls back to the default instead of failing', () => {
  sandbox(() => {
    for (const bad of ['relative/dir', 42, null, ['x'], '~bob/x']) {
      fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
      fs.writeFileSync(userConfigPath(), JSON.stringify({ plugins: { suite: { reposDir: bad } } }));
      assert.equal(suiteSetting('reposDir')!.source, 'default', JSON.stringify(bad));
      assert.equal(reposDir(), path.join(os.homedir(), 'dev'));
    }
    fs.writeFileSync(userConfigPath(), '{broken');
    assert.equal(reposDir(), path.join(os.homedir(), 'dev'));
  });
});

test('a read-only pf home is reported, not thrown', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ro-'));
  const blocker = path.join(home, 'file');
  fs.writeFileSync(blocker, 'x');
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = path.join(blocker, 'inside'); // a folder cannot be made below a file
  try {
    const r = setSuiteSetting('reposDir', '/tmp/x');
    assert.equal(r.ok, false);
    assert.equal((r as { kind: string }).kind, 'save');
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('newRepoPath joins one plain folder name under reposDir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-repos-'));
  sandbox(() => {
    assert.deepEqual(newRepoPath('query-foo'), { path: path.join(base, 'query-foo') });
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '.', '', 'x\0y']) assert.ok('error' in newRepoPath(bad), JSON.stringify(bad));
    assert.deepEqual(suiteSettings().map((s) => s.key), ['reposDir']);
  }, base);
  fs.rmSync(base, { recursive: true, force: true });
});
