import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARTS } from '../src/commands/art.js';
import { allCommands } from '../src/commands/index.js';

test('every picture has actions and the commands that show octopuses exist', () => {
  const names = allCommands().map((c) => c.name);
  for (const a of ARTS) {
    assert.ok(a.actions.length > 0);
    if (a.mascot) assert.ok(names.includes(a.actions[0]!.replace('pf ', '')), a.name);
  }
  assert.equal(new Set(ARTS.map((a) => a.name)).size, ARTS.length);
  assert.ok(names.includes('art'));
});
