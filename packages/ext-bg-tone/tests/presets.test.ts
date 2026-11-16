import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS, mergePalette, normalizeHex, parsePalette } from '../src/presets.ts';

test('built-in presets are valid, unique and numerous', () => {
	assert.ok(BUILTIN_PRESETS.length >= 40);
	const colors = BUILTIN_PRESETS.map(p => p.color);
	assert.equal(new Set(colors).size, colors.length);
	for (const c of colors) {
		assert.equal(normalizeHex(c), c);
	}
	assert.equal(BUILTIN_PRESETS[0].label, 'Blue');
});

test('normalizeHex expands and lowercases', () => {
	assert.equal(normalizeHex('#ABC'), '#aabbcc');
	assert.equal(normalizeHex('nope'), undefined);
	assert.equal(normalizeHex(5), undefined);
});

test('parsePalette keeps valid entries and drops the rest', () => {
	assert.deepEqual(parsePalette(undefined), []);
	assert.deepEqual(
		parsePalette([{ label: 'Brand', color: '#112233' }, '#ABC', { color: 'bad' }, 3, null, { color: '#445566' }]),
		[
			{ label: 'Brand', color: '#112233', group: 'Custom' },
			{ label: '#aabbcc', color: '#aabbcc', group: 'Custom' },
			{ label: '#445566', color: '#445566', group: 'Custom' },
		],
	);
});

test('mergePalette dedupes by color and lets built-ins win', () => {
	const merged = mergePalette([{ label: 'Mine', color: '#3B82F6' }, { label: 'Brand', color: '#010203' }]);
	assert.equal(merged.length, BUILTIN_PRESETS.length + 1);
	assert.equal(merged.find(p => p.color === '#3b82f6')?.label, 'Blue');
	assert.equal(merged[merged.length - 1].label, 'Brand');
});
