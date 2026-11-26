import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAheadCount } from '../src/gitAhead.ts';

const A = 'a'.repeat(40);
const B = 'b1'.repeat(20);

test('parseAheadCount counts hashes and ignores noise', () => {
	assert.equal(parseAheadCount(''), 0);
	assert.equal(parseAheadCount(`${A}\n${B}\n`), 2);
	assert.equal(parseAheadCount(`warning: x\n${A}\n\nfatal`), 1);
	assert.equal(parseAheadCount('c'.repeat(64)), 1);
});
