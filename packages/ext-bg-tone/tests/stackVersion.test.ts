import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStackVersion } from '../src/stackVersion.ts';

test('parseStackVersion reads the stack version of versions.json', () => {
	assert.equal(parseStackVersion('{"stack":{"version":"3.5","since":"2026-11-17"},"packages":{}}'), '3.5');
	assert.equal(parseStackVersion('{"stack":{"version":" 1.0.2 "}}'), '1.0.2');
});

test('parseStackVersion shows nothing for a missing or odd file', () => {
	assert.equal(parseStackVersion(null), undefined);
	assert.equal(parseStackVersion('not json'), undefined);
	assert.equal(parseStackVersion('[]'), undefined);
	assert.equal(parseStackVersion('{"packages":{}}'), undefined);
	assert.equal(parseStackVersion('{"stack":{"version":"<b>x</b>"}}'), undefined);
	assert.equal(parseStackVersion('{"stack":{"version":3.5}}'), undefined);
});
