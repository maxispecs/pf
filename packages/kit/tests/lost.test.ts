import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOST_HEIGHT, LOST_MIN_ROWS, LOST_WIDTH, lostFits, renderLost, trueColor, xterm256 } from '../src/ui/lost.js';
import { palette, stripAnsi, type Palette } from '../src/ui/palette.js';
import { TRAVOLTA_BG, TRAVOLTA_CHARS, TRAVOLTA_DOTS, TRAVOLTA_FG } from '../src/ui/travolta-art.js';

const withColor = (on: boolean): Palette => ({ ...palette(process.stderr), on });

test('travolta art is consistent: every version has the same rows and width', () => {
  for (const art of [TRAVOLTA_CHARS, TRAVOLTA_FG, TRAVOLTA_BG]) assert.equal(art.length, TRAVOLTA_DOTS.length);
  TRAVOLTA_DOTS.forEach((row, i) => {
    assert.equal(row.length, LOST_WIDTH);
    assert.equal(TRAVOLTA_CHARS[i]!.length, LOST_WIDTH);
    assert.match(TRAVOLTA_FG[i]!, new RegExp(`^([0-9a-f]{6}|-{6}){${LOST_WIDTH}}$`));
    assert.match(TRAVOLTA_BG[i]!, new RegExp(`^([0-9a-f]{6}|-{6}){${LOST_WIDTH}}$`));
  });
});

test('travolta is braille dots without color and a colored picture with it', () => {
  const plain = renderLost(withColor(false));
  assert.doesNotMatch(plain, /\x1b/);
  assert.ok(plain.includes(TRAVOLTA_DOTS[8]!));
  assert.equal(plain.split('\n').length, LOST_HEIGHT);

  for (const full of [true, false]) {
    const rows = renderLost(withColor(true), full).split('\n').slice(1);
    assert.equal(rows.length, TRAVOLTA_CHARS.length);
    rows.forEach((row, i) => {
      assert.equal(stripAnsi(row), '  ' + TRAVOLTA_CHARS[i]);
      assert.ok(row.endsWith('\x1b[0m'), 'every row resets its colors');
    });
    assert.equal(renderLost(withColor(true), full).includes(';2;'), full, 'true color only when asked for');
  }
});

test('colors map to true color or the nearest xterm-256 color', () => {
  assert.equal(trueColor({ COLORTERM: 'truecolor' }), true);
  assert.equal(trueColor({}), false);
  assert.equal(xterm256(0, 0, 0), 232);
  assert.equal(xterm256(255, 0, 0), 196);
  assert.equal(xterm256(128, 128, 128), 244);
});

test('travolta only shows on a terminal big enough for him', () => {
  assert.equal(lostFits(undefined, undefined), false);
  assert.equal(lostFits(LOST_WIDTH + 2, 10), false, 'a very short window skips him');
  assert.equal(lostFits(LOST_WIDTH + 2, LOST_MIN_ROWS), true, 'a window shorter than the picture still gets him');
  assert.equal(lostFits(LOST_WIDTH + 1, 40), false);
  assert.equal(lostFits(80, 40), true);
});
