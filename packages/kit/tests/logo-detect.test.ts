import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadRepoConfig, setRepoConfigSection } from '../src/config.js';
import { diskIo, findRepoLogo, normalizeLogoPath, readmeImages, type LogoIo } from '../src/detect/logo.js';
import { json, mkRepo } from './helpers.js';

/** An in-memory repo: files (path -> text) and the paths git would ignore. */
const memIo = (files: Record<string, string>, ignored: string[] = []): LogoIo => ({
  isFile: (rel) => rel in files,
  readText: (rel) => files[rel] ?? null,
  ignored: (rel) => ignored.includes(rel),
});

test('normalizeLogoPath accepts repo images only', () => {
  assert.equal(normalizeLogoPath('assets/logo.svg'), 'assets/logo.svg');
  assert.equal(normalizeLogoPath('./docs/Logo.PNG'), 'docs/Logo.PNG');
  assert.equal(normalizeLogoPath('/assets/logo.png'), 'assets/logo.png');
  for (const bad of ['', '../logo.png', 'a/../../logo.png', '//cdn/logo.png', '~/logo.png', 'C:/logo.png', 'logo.txt', 'dir/']) {
    assert.equal(normalizeLogoPath(bad), null, bad);
  }
});

test('readmeImages lists local images in document order and skips remote ones', () => {
  const md = [
    '[![build](https://img.shields.io/x.svg)](https://ci)',
    '<img alt="x" src="./docs/banner.png" width="100">',
    '![logo](assets/my%20logo.svg "The logo")',
    '![remote](//cdn.example.com/a.png)',
  ].join('\n');
  assert.deepEqual(readmeImages(md), ['./docs/banner.png', 'assets/my logo.svg']);
});

test('findRepoLogo prefers a logo file over an icon, an svg over a png, and the root over a folder', () => {
  assert.deepEqual(findRepoLogo('/r', memIo({ 'assets/logo.png': '', 'public/icon.svg': '' })), { path: 'assets/logo.png', reason: 'logo.png in assets' });
  assert.equal(findRepoLogo('/r', memIo({ 'logo.png': '', 'logo.svg': '' }))?.path, 'logo.svg');
  assert.equal(findRepoLogo('/r', memIo({ 'logo.png': '', 'assets/logo.svg': '' }))?.path, 'logo.png');
  assert.equal(findRepoLogo('/r', memIo({ 'public/favicon.ico': '', 'media/icon.png': '' }))?.path, 'media/icon.png');
});

test('findRepoLogo skips node_modules and ignored files', () => {
  assert.equal(findRepoLogo('/r', memIo({ 'logo.png': '' }, ['logo.png'])), null);
  assert.equal(findRepoLogo('/r', memIo({ 'assets/logo.png': '' }, ['assets/logo.png'])), null);
  assert.equal(findRepoLogo('/r', memIo({ 'assets/logo.svg': '', 'public/logo.png': '' }, ['assets/logo.svg']))?.path, 'public/logo.png');
});

test('findRepoLogo never points into node_modules from a README', () => {
  const io = memIo({ 'README.md': '![x](node_modules/pkg/logo.png)', 'node_modules/pkg/logo.png': '' });
  assert.equal(findRepoLogo('/r', io), null);
});

test('findRepoLogo falls back to the first usable README image', () => {
  const io = memIo({ 'README.md': '![x](https://a/b.png)\n![gone](docs/missing.png)\n![hero](docs/hero.webp)', 'docs/hero.webp': '' });
  assert.deepEqual(findRepoLogo('/r', io), { path: 'docs/hero.webp', reason: 'the first image in README.md' });
  assert.equal(findRepoLogo('/r', memIo({ 'README.md': 'no images' })), null);
  assert.equal(findRepoLogo('/r', memIo({})), null);
});

test('findRepoLogo reads a real folder', () => {
  const root = mkRepo({ 'assets/logo.svg': '<svg/>', 'src/index.ts': '' });
  assert.equal(findRepoLogo(root)?.path, 'assets/logo.svg');
  assert.equal(diskIo(root).isFile('assets'), false);
  assert.equal(findRepoLogo(mkRepo({ 'src/index.ts': '' })), null);
});

test('setRepoConfigSection merges into bgTone, keeps the rest and the indentation, and reports a no-op', () => {
  const root = mkRepo({ 'pulpfixer.json': '{\n\t"id": "a-1",\n\t"bgTone": { "color": "#fff" }\n}\n' });
  assert.deepEqual(setRepoConfigSection(root, 'bgTone', { logo: 'assets/logo.svg' }, { dryRun: true }), { ok: true, changed: true });
  assert.equal(loadRepoConfig(root).bgTone?.logo, undefined);
  assert.deepEqual(setRepoConfigSection(root, 'bgTone', { logo: 'assets/logo.svg' }), { ok: true, changed: true });
  const text = fs.readFileSync(path.join(root, 'pulpfixer.json'), 'utf8');
  assert.ok(text.startsWith('{\n\t"id": "a-1"') && text.endsWith('}\n'));
  assert.deepEqual(loadRepoConfig(root).bgTone, { color: '#fff', logo: 'assets/logo.svg' });
  assert.deepEqual(setRepoConfigSection(root, 'bgTone', { logo: 'assets/logo.svg' }), { ok: true, changed: false });
});

test('setRepoConfigSection creates the file, and refuses a file it cannot edit safely', () => {
  const fresh = mkRepo({});
  assert.deepEqual(setRepoConfigSection(fresh, 'bgTone', { logo: 'l.png' }), { ok: true, changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'pulpfixer.json'), 'utf8')), { bgTone: { logo: 'l.png' } });

  const broken = mkRepo({ 'pulpfixer.json': '{ nope' });
  assert.equal(setRepoConfigSection(broken, 'bgTone', { logo: 'l.png' }).ok, false);
  assert.equal(fs.readFileSync(path.join(broken, 'pulpfixer.json'), 'utf8'), '{ nope');
  const array = mkRepo({ 'pulpfixer.json': '[]' });
  assert.equal(setRepoConfigSection(array, 'bgTone', { logo: 'l.png' }).ok, false);
  const notObject = mkRepo({ 'pulpfixer.json': json({ bgTone: 3 }) });
  assert.equal(setRepoConfigSection(notObject, 'bgTone', { logo: 'l.png' }).ok, false);
});

test('a legacy pf.json is edited in place until pf rp converts it', () => {
  const root = mkRepo({ 'pf.json': json({ name: 'old' }) });
  assert.deepEqual(setRepoConfigSection(root, 'bgTone', { logo: 'l.png' }), { ok: true, changed: true });
  assert.ok(!fs.existsSync(path.join(root, 'pulpfixer.json')));
  assert.deepEqual(loadRepoConfig(root).bgTone, { logo: 'l.png' });
});
