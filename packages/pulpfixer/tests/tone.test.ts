import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadRepoConfig } from '@pulpfixer/kit/config';
import { setupTone, setupToneExtension, setupToneLogo, type ToneDeps } from '../src/commands/tone.js';
import { json, mkRepo } from './helpers.js';

const status = (over: Partial<ReturnType<ToneDeps['status']>> = {}) => ({ cursor: true, cli: true, installed: null, unknown: false, ...over });

function deps(over: Partial<ToneDeps> = {}): ToneDeps & { installed: number; asked: string[] } {
  const d = {
    installed: 0,
    asked: [] as string[],
    status: () => status(),
    install: async () => {
      d.installed++;
      return 0;
    },
    interactive: () => true,
    confirm: async (q: string) => {
      d.asked.push(q);
      return true;
    },
    ...over,
  };
  return d;
}

const config = (root: string) => fs.readFileSync(path.join(root, 'pulpfixer.json'), 'utf8');

test('pf rp sets bgTone.logo from an image in the repo and keeps the rest of pulpfixer.json', () => {
  const root = mkRepo({ 'pulpfixer.json': json({ id: 'a-1', commands: { dev: 'x' } }), 'assets/logo.svg': '<svg/>' });
  const done: string[] = [];
  assert.equal(setupToneLogo(root, false, done), 0);
  assert.match(done[0]!, /set bgTone\.logo to assets\/logo\.svg in pulpfixer\.json/);
  const cfg = loadRepoConfig(root);
  assert.equal(cfg.bgTone?.logo, 'assets/logo.svg');
  assert.equal(cfg.id, 'a-1');
  assert.equal(cfg.commands.dev?.run, 'x');
});

test('pf rp --dry-run says what it would set and writes nothing', () => {
  const root = mkRepo({ 'pulpfixer.json': json({ id: 'a-1' }), 'logo.png': '' });
  const before = config(root);
  const done: string[] = [];
  setupToneLogo(root, true, done);
  assert.match(done[0]!, /would set bgTone\.logo to logo\.png/);
  assert.equal(config(root), before);
});

test('an existing bgTone.logo is never replaced, even when it is missing on disk', () => {
  const root = mkRepo({ 'pulpfixer.json': json({ bgTone: { logo: 'brand/mine.svg' } }), 'brand/mine.svg': '', 'assets/logo.svg': '' });
  const done: string[] = [];
  setupToneLogo(root, false, done);
  assert.deepEqual(done, ['logo: bgTone.logo is already brand/mine.svg']);
  assert.equal(loadRepoConfig(root).bgTone?.logo, 'brand/mine.svg');

  const gone = mkRepo({ 'pulpfixer.json': json({ bgTone: { logo: 'brand/gone.svg' } }), 'assets/logo.svg': '' });
  const d2: string[] = [];
  setupToneLogo(gone, false, d2);
  assert.match(d2[0]!, /missing from the repo, left as is/);
  assert.equal(loadRepoConfig(gone).bgTone?.logo, 'brand/gone.svg');

  const bad = mkRepo({ 'pulpfixer.json': json({ bgTone: { logo: '../x.png' } }) });
  const d3: string[] = [];
  setupToneLogo(bad, false, d3);
  assert.match(d3[0]!, /not a usable path/);
});

test('a repo without an image gets no logo and no file', () => {
  const root = mkRepo({ 'src/index.ts': '' });
  const done: string[] = [];
  assert.equal(setupToneLogo(root, false, done), 0);
  assert.match(done[0]!, /no logo image found/);
  assert.ok(!fs.existsSync(path.join(root, 'pulpfixer.json')));
});

test('an unreadable pulpfixer.json is reported and left alone', () => {
  const root = mkRepo({ 'pulpfixer.json': '{ nope', 'logo.svg': '' });
  assert.equal(setupToneLogo(root, false, []), 1);
  assert.equal(config(root), '{ nope');
});

test('the extension is offered when Cursor lacks it, and installed on yes', async () => {
  const d = deps();
  const done: string[] = [];
  assert.equal(await setupToneExtension(false, done, d), 0);
  assert.equal(d.installed, 1);
  assert.equal(d.asked.length, 1);
  assert.match(done[0]!, /Background Tone installed in Cursor/);
});

test('without a terminal, or on a dry run, the extension is only mentioned', async () => {
  const quiet = deps({ interactive: () => false });
  const done: string[] = [];
  await setupToneExtension(false, done, quiet);
  assert.equal(quiet.installed, 0);
  assert.match(done[0]!, /run .*pf sys apply suite.* to install it/);

  const dry = deps();
  const d2: string[] = [];
  await setupToneExtension(true, d2, dry);
  assert.equal(dry.installed, 0);
  assert.equal(dry.asked.length, 0);
  assert.match(d2[0]!, /would offer to install/);
});

test('a declined or failed install is not an error for pf rp', async () => {
  const no = deps({ confirm: async () => false });
  const d1: string[] = [];
  assert.equal(await setupToneExtension(false, d1, no), 0);
  assert.equal(no.installed, 0);
  assert.match(d1[0]!, /not installed/);

  const fails = deps({ install: async () => 1 });
  const d2: string[] = [];
  assert.equal(await setupToneExtension(false, d2, fails), 0);
  assert.equal(d2[0], 'extension: install failed');
});

test('an installed extension is reported with its version and never reinstalled', async () => {
  const d = deps({ status: () => status({ installed: '1.0.0' }) });
  const done: string[] = [];
  await setupToneExtension(false, done, d);
  assert.equal(d.installed, 0);
  assert.equal(d.asked.length, 0);
  assert.match(done[0]!, /Background Tone v1\.0 is installed in Cursor/);
});

test('no Cursor, no launcher, or an unreadable list: nothing to do', async () => {
  for (const [s, re] of [
    [status({ cursor: false, cli: false }), /Cursor not found/],
    [status({ cli: false }), /cursor command was not found/],
    [status({ unknown: true }), /could not read/],
  ] as const) {
    const d = deps({ status: () => s });
    const done: string[] = [];
    assert.equal(await setupToneExtension(false, done, d), 0);
    assert.equal(d.installed + d.asked.length, 0);
    assert.match(done[0]!, re);
  }
});

test('setupTone does the logo and then the extension', async () => {
  const root = mkRepo({ 'assets/logo.svg': '' });
  const done: string[] = [];
  assert.equal(await setupTone(root, false, done, deps({ interactive: () => false })), 0);
  assert.equal(done.length, 2);
  assert.match(done[0]!, /^logo: set/);
  assert.match(done[1]!, /^extension:/);
});
