import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseHex,
	toHex,
	blend,
	blendHex,
	normalizeStrength,
	defaultBaseFor,
	resolveTint,
	normalizeSurfaces,
	colorFromName,
	hashString,
	MAX_STRENGTH,
	DEFAULT_STRENGTH,
	OWNED_KEYS,
} from '../src/color.ts';

test('parseHex handles 3, 4, 6 and 8 digit forms', () => {
	assert.deepEqual(parseHex('#fff'), { r: 255, g: 255, b: 255 });
	assert.deepEqual(parseHex('#f00f'), { r: 255, g: 0, b: 0 });
	assert.deepEqual(parseHex('#3b82f6'), { r: 0x3b, g: 0x82, b: 0xf6 });
	assert.deepEqual(parseHex('  #3B82F680 '), { r: 0x3b, g: 0x82, b: 0xf6 });
});

test('parseHex rejects invalid input', () => {
	for (const bad of ['', 'red', '#12', '#12345', '#gggggg', '3b82f6', undefined, null]) {
		assert.equal(parseHex(bad as string), undefined, String(bad));
	}
});

test('toHex pads and clamps', () => {
	assert.equal(toHex({ r: 0, g: 5, b: 255 }), '#0005ff');
	assert.equal(toHex({ r: -10, g: 300, b: 127.6 }), '#00ff80');
});

test('blend math', () => {
	const base = { r: 0, g: 0, b: 0 };
	const tone = { r: 200, g: 100, b: 50 };
	assert.deepEqual(blend(base, tone, 0), base);
	assert.deepEqual(blend(base, tone, 1), tone);
	assert.deepEqual(blend(base, tone, 0.5), { r: 100, g: 50, b: 25 });
	// out-of-range strength is clamped
	assert.deepEqual(blend(base, tone, -1), base);
	assert.deepEqual(blend(base, tone, 5), tone);
});

test('blendHex', () => {
	assert.equal(blendHex('#000000', '#ffffff', 0.5), '#808080');
	assert.equal(blendHex('#1e1e1e', '#ff0000', 0), '#1e1e1e');
	assert.equal(blendHex('nope', '#ff0000', 0.1), undefined);
	assert.equal(blendHex('#1e1e1e', 'nope', 0.1), undefined);
});

test('normalizeStrength clamps and falls back', () => {
	assert.equal(normalizeStrength(0.1), 0.1);
	assert.equal(normalizeStrength(-1), 0);
	assert.equal(normalizeStrength(10), MAX_STRENGTH);
	assert.equal(normalizeStrength(NaN), DEFAULT_STRENGTH);
	assert.equal(normalizeStrength('0.2'), DEFAULT_STRENGTH);
	assert.equal(normalizeStrength(undefined), DEFAULT_STRENGTH);
});

test('defaultBaseFor', () => {
	assert.equal(defaultBaseFor('dark'), '#1e1e1e');
	assert.equal(defaultBaseFor('light'), '#ffffff');
	assert.equal(defaultBaseFor('light', 'sideBar'), '#f3f3f3');
	assert.equal(defaultBaseFor('dark', 'titleBar'), '#3c3c3c');
	assert.equal(defaultBaseFor('highContrast'), undefined);
	assert.equal(defaultBaseFor('highContrastLight'), undefined);
});

test('colorFromName is stable, valid and varies by name', () => {
	const a = colorFromName('my-repo');
	assert.equal(a, colorFromName('my-repo'));
	assert.match(a, /^#[0-9a-f]{6}$/);
	assert.notEqual(colorFromName('repo-a'), colorFromName('repo-b'));
	assert.equal(hashString('a'), 0xe40c292c);
});

test('normalizeSurfaces', () => {
	assert.deepEqual(normalizeSurfaces(undefined), ['sideBar', 'titleBar']);
	assert.deepEqual(normalizeSurfaces(['editor', 'bogus', 'sideBar']), ['sideBar', 'editor']);
	assert.deepEqual(normalizeSurfaces([]), []);
});

test('resolveTint', () => {
	const settings = { enabled: true, color: '#ff0000', strength: 0.1, surfaces: ['editor'], baseColors: {} };
	// dark: 0x1e * 0.9 + 0xff * 0.1 = 52.6 -> 0x35 ; 0x1e * 0.9 = 27 -> 0x1b
	assert.deepEqual(resolveTint(settings, 'dark'), { type: 'tint', values: { 'editor.background': '#351b1b' } });
	// light: 255 * 0.9 + 255 * 0.1 = 255 ; 255 * 0.9 = 229.5 -> 0xe6
	assert.deepEqual(resolveTint(settings, 'light'), { type: 'tint', values: { 'editor.background': '#ffe6e6' } });
	assert.deepEqual(resolveTint(settings, 'highContrast'), { type: 'none' });
	assert.deepEqual(
		resolveTint({ ...settings, baseColors: { editor: '#000000' } }, 'highContrast'),
		{ type: 'tint', values: { 'editor.background': '#1a0000' } },
	);
	assert.deepEqual(resolveTint({ ...settings, enabled: false }, 'dark'), { type: 'none' });
	assert.deepEqual(resolveTint({ ...settings, color: '' }, 'dark'), { type: 'none' });
	assert.deepEqual(resolveTint({ ...settings, surfaces: [] }, 'dark'), { type: 'none' });
	assert.equal(resolveTint({ ...settings, color: 'blue' }, 'dark').type, 'invalid');
	assert.equal(resolveTint({ ...settings, baseColors: { editor: 'x' } }, 'dark').type, 'invalid');
	// strength is clamped to the max
	assert.deepEqual(
		resolveTint({ ...settings, strength: 5, baseColors: { editor: '#000000' } }, 'dark'),
		{ type: 'tint', values: { 'editor.background': '#4d0000' } },
	);
});

test('resolveTint defaults tint the gray chrome and leave the editor alone', () => {
	const settings = { enabled: true, color: '#00ff00', strength: 0.1, surfaces: undefined, baseColors: undefined };
	const result = resolveTint(settings, 'light');
	assert.equal(result.type, 'tint');
	if (result.type === 'tint') {
		assert.deepEqual(Object.keys(result.values).sort(), [
			'sideBar.background',
			'titleBar.activeBackground',
			'titleBar.inactiveBackground',
		]);
		assert.equal(result.values['editor.background'], undefined);
		// #f3f3f3 * 0.9 + #00ff00 * 0.1 -> r 218.7 -> 0xdb, g 243*.9+25.5=244.2 -> 0xf4
		assert.equal(result.values['sideBar.background'], '#dbf4db');
	}
});

test('extra surfaces resolve to their own keys', () => {
	const settings = {
		enabled: true,
		color: '#ff0000',
		strength: 0.1,
		surfaces: ['activityBar', 'tabBar', 'panel', 'statusBar'],
		baseColors: {},
	};
	const result = resolveTint(settings, 'dark');
	assert.equal(result.type, 'tint');
	if (result.type === 'tint') {
		assert.deepEqual(Object.keys(result.values).sort(), [
			'activityBar.background',
			'editorGroupHeader.tabsBackground',
			'panel.background',
			'statusBar.background',
		]);
		// panel: same base as the editor in dark (#1e1e1e) at 0.1
		assert.equal(result.values['panel.background'], '#351b1b');
		// status bar uses 5x strength: #007acc * 0.5 + #ff0000 * 0.5
		assert.equal(result.values['statusBar.background'], '#803d66');
	}
});

test('normalizeSurfaces keeps canonical order for the new surfaces', () => {
	assert.deepEqual(normalizeSurfaces(['panel', 'activityBar', 'sideBar']), ['sideBar', 'activityBar', 'panel']);
});

test('accentBorder adds raw tone borders, but not for high contrast themes', () => {
	const settings = { enabled: true, color: '#3b82f6', strength: 0.1, surfaces: [], baseColors: {}, accentBorder: true };
	assert.deepEqual(resolveTint(settings, 'dark'), {
		type: 'tint',
		values: { 'titleBar.border': '#3b82f6', 'tab.activeBorder': '#3b82f6' },
	});
	assert.deepEqual(resolveTint(settings, 'highContrast'), { type: 'none' });
	assert.deepEqual(resolveTint({ ...settings, accentBorder: false }, 'dark'), { type: 'none' });
});

test('OWNED_KEYS covers every surface and accent key exactly once', () => {
	assert.equal(new Set(OWNED_KEYS).size, OWNED_KEYS.length);
	for (const key of ['panel.background', 'statusBar.background', 'titleBar.border', 'tab.activeBorder']) {
		assert.ok(OWNED_KEYS.includes(key), key);
	}
});
