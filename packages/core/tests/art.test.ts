import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stripAnsi } from '@pulpfixer/kit/ui/palette';
import { ansiFile, artActions, artFor, BUILTIN_ARTS, cleanAnsi, customArts } from '../src/art/index.js';
import { allCommands } from '../src/commands/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-art-'));

test('the shipped art.json maps real commands to built-in pictures', () => {
  const names = allCommands().map((c) => c.name);
  const shipped = artActions([path.join(import.meta.dirname, '..', 'assets', 'art')]);
  assert.ok(Object.keys(shipped).length >= 3);
  for (const [cmd, art] of Object.entries(shipped)) {
    assert.ok(names.includes(cmd), cmd);
    assert.ok(art in BUILTIN_ARTS, art);
  }
  assert.ok(names.includes('art'));
});

test('your art folder wins over the shipped one: actions merge, same-named files override', () => {
  const mine = tmp();
  const shipped = tmp();
  fs.writeFileSync(path.join(shipped, 'art.json'), '{"actions":{"update":"octopus-update","repo":"octopus-repo"}}');
  fs.writeFileSync(path.join(mine, 'art.json'), '{"actions":{"update":"coffee","repo":"none","deploy":"coffee"}}');
  fs.writeFileSync(path.join(shipped, 'coffee.ansi'), 'shipped');
  fs.writeFileSync(path.join(mine, 'coffee.ansi'), 'mine');
  const dirs = [mine, shipped];
  assert.deepEqual(artActions(dirs), { update: 'coffee', repo: 'none', deploy: 'coffee' });
  assert.equal(fs.readFileSync(ansiFile('coffee', dirs)!, 'utf8'), 'mine');
  assert.deepEqual(Object.keys(customArts(dirs)), ['coffee']);
  assert.equal(ansiFile('../coffee', dirs), null, 'names cannot leave the folder');
  assert.equal(artFor('repo', dirs), null, 'none shows nothing');
  assert.equal(artFor('missing', dirs), null);
});

test('a custom picture is read from its .ansi file with only color escapes kept', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'art.json'), '{"actions":{"update":"cup"}}');
  fs.writeFileSync(path.join(dir, 'cup.ansi'), '\x1b[2J\x1b[38;2;1;2;3mab\x1b[0m\x1b]0;title\x07\x1b[10A\ncd\n\n');
  const art = artFor('update', [dir])!;
  assert.deepEqual(art.lines.map((l) => stripAnsi(l)), ['', '  ab', '  cd']);
  assert.ok(art.lines[1]!.includes('\x1b[38;2;1;2;3m'));
  assert.ok(!art.lines.join('').includes('\x1b[2J') && !art.lines.join('').includes('\x1b[10A'));
  assert.equal(art.width, 2);
  assert.deepEqual(cleanAnsi('x\r\ny'), ['x\x1b[0m', 'y\x1b[0m']);
});
