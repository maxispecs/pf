import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePreview, isWritableKey, sanitizeSetting } from '../src/settingsModel.ts';

test('isWritableKey is a strict whitelist', () => {
	assert.equal(isWritableKey('color'), true);
	assert.equal(isWritableKey('palette'), false);
	assert.equal(isWritableKey('__proto__'), false);
	assert.equal(isWritableKey(1), false);
});

test('sanitizeSetting validates booleans, colors and strength', () => {
	assert.deepEqual(sanitizeSetting('enabled', false), { ok: true, value: false });
	assert.equal(sanitizeSetting('enabled', 'yes').ok, false);
	assert.deepEqual(sanitizeSetting('color', '#ABC'), { ok: true, value: '#aabbcc' });
	assert.deepEqual(sanitizeSetting('color', ''), { ok: true, value: undefined });
	assert.equal(sanitizeSetting('color', 'red').ok, false);
	assert.deepEqual(sanitizeSetting('strength', 9), { ok: true, value: 0.3 });
	assert.deepEqual(sanitizeSetting('strength', 0.12345), { ok: true, value: 0.123 });
	assert.equal(sanitizeSetting('strength', '0.1').ok, false);
});

test('sanitizeSetting normalizes lists and objects', () => {
	assert.deepEqual(sanitizeSetting('surfaces', ['panel', 'bogus', 'sideBar']), { ok: true, value: ['sideBar', 'panel'] });
	assert.equal(sanitizeSetting('surfaces', 'sideBar').ok, false);
	assert.deepEqual(sanitizeSetting('baseColors', { sideBar: '#FFF', bogus: 'x', editor: '' }), {
		ok: true,
		value: { sideBar: '#ffffff' },
	});
	assert.deepEqual(sanitizeSetting('baseColors', {}), { ok: true, value: undefined });
	assert.equal(sanitizeSetting('baseColors', { sideBar: 'nope' }).ok, false);
	assert.deepEqual(sanitizeSetting('logoLocations', ['windowTitle', 'x']), { ok: true, value: ['windowTitle'] });
});

test('sanitizeSetting validates logo path and title text', () => {
	assert.deepEqual(sanitizeSetting('logo', './assets/logo.png'), { ok: true, value: 'assets/logo.png' });
	assert.deepEqual(sanitizeSetting('logo', ''), { ok: true, value: undefined });
	assert.equal(sanitizeSetting('logo', '../logo.png').ok, false);
	assert.deepEqual(sanitizeSetting('titleEmoji', ' 🟦 '), { ok: true, value: '🟦' });
	assert.deepEqual(sanitizeSetting('titleEmoji', '   '), { ok: true, value: undefined });
	assert.equal(sanitizeSetting('titleEmoji', 5).ok, false);
});

test('computePreview shows tinted and untouched surfaces', () => {
	const input = {
		enabled: true,
		color: '#ff0000',
		strength: 0.1,
		surfaces: ['editor' as const],
		baseColors: {},
		accentBorder: true,
	};
	const preview = computePreview(input, 'dark');
	assert.equal(preview.tinted, true);
	assert.equal(preview.surfaces.editor, '#351b1b');
	assert.equal(preview.surfaces.sideBar, '#252526'); // not selected: untouched base
	assert.equal(preview.accent, '#ff0000');
	assert.equal(preview.error, undefined);

	const off = computePreview({ ...input, enabled: false }, 'dark');
	assert.equal(off.tinted, false);
	assert.equal(off.surfaces.editor, '#1e1e1e');
	assert.equal(off.accent, undefined);

	const bad = computePreview({ ...input, color: 'zzz' }, 'dark');
	assert.equal(typeof bad.error, 'string');

	const hc = computePreview(input, 'highContrast');
	assert.equal(hc.tinted, false);
	assert.equal(hc.surfaces.sideBar, '#808080');
});
