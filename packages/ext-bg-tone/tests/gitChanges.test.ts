import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countChangedFiles } from '../src/gitChanges.ts';

test('countChangedFiles counts one per listed file', () => {
	assert.equal(countChangedFiles(''), 0);
	assert.equal(countChangedFiles(' M a.ts\0?? b.ts\0A  c.ts\0'), 3);
});

test('countChangedFiles does not count the old path of a rename', () => {
	assert.equal(countChangedFiles('R  new.ts\0old.ts\0 M other.ts\0'), 2);
	assert.equal(countChangedFiles(' R new.ts\0old.ts\0'), 1);
});
