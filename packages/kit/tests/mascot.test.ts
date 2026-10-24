import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mascotPixels, mascotSize, renderMascot, type MascotName } from '../src/ui/mascot.js';
import { palette, stripAnsi, type Palette } from '../src/ui/palette.js';

const withColor = (on: boolean): Palette => ({ ...palette(process.stderr), on });
const NAMES: MascotName[] = ['repo', 'update', 'agent'];

test('every mascot is a rectangle of known pixels with an even height', () => {
  for (const name of NAMES) {
    const rows = mascotPixels(name);
    assert.equal(rows.length % 2, 0);
    for (const row of rows) assert.match(row, /^[.owkcrgyY]{24}$/);
  }
  assert.notDeepEqual(mascotPixels('repo'), mascotPixels('update'));
  assert.notDeepEqual(mascotPixels('update'), mascotPixels('agent'));
});

test('mascots have no plain version, and both color versions match their size', () => {
  assert.equal(renderMascot('repo', withColor(false)), '');
  for (const name of NAMES) {
    for (const flat of [false, true]) {
      const { width, height } = mascotSize(flat);
      const rows = renderMascot(name, withColor(true), true, flat).split('\n').slice(1);
      assert.equal(rows.length, height);
      for (const row of rows) {
        assert.equal(stripAnsi(row).length, width + 2);
        assert.ok(!row.includes('\x1b') || row.endsWith('\x1b[0m') || row.endsWith(' '), 'colors are reset');
      }
    }
  }
});

test('flat mascots use no block characters', () => {
  assert.doesNotMatch(stripAnsi(renderMascot('agent', withColor(true), false, true)), /[▀-▟]/);
});
