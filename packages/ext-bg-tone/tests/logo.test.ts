import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	validateLogoPath,
	toRelativeLogoPath,
	logoPathFromDrop,
	normalizeLogoLocations,
	normalizeTitlePrefix,
	buildWindowTitle,
	DEFAULT_TITLE_TEMPLATE,
	isGeneratedTitle,
} from '../src/logo.ts';

test('validateLogoPath accepts relative image paths and normalizes them', () => {
	assert.deepEqual(validateLogoPath('assets/logo.png'), { ok: true, path: 'assets/logo.png' });
	assert.deepEqual(validateLogoPath('  ./assets//logo.SVG '), { ok: true, path: 'assets/logo.SVG' });
	assert.deepEqual(validateLogoPath('.vscode\\icon.webp'), { ok: true, path: '.vscode/icon.webp' });
	assert.deepEqual(validateLogoPath('a/b/../logo.jpg'), { ok: true, path: 'a/logo.jpg' });
});

test('validateLogoPath rejects traversal, absolute paths and non-images', () => {
	for (const bad of [
		'../logo.png',
		'a/../../logo.png',
		'/etc/logo.png',
		'C:\\logo.png',
		'C:/logo.png',
		'~/logo.png',
		'logo.txt',
		'logo',
		'assets/',
		'.',
		'',
		'   ',
		undefined,
		42,
	]) {
		assert.equal(validateLogoPath(bad).ok, false, String(bad));
	}
});

test('toRelativeLogoPath only returns paths inside the root', () => {
	const root = path.join(path.sep, 'work', 'repo');
	assert.equal(toRelativeLogoPath(root, path.join(root, 'assets', 'logo.png')), 'assets/logo.png');
	assert.equal(toRelativeLogoPath(root, path.join(root, '..', 'other', 'logo.png')), undefined);
	assert.equal(toRelativeLogoPath(root, path.join(root, 'notes.txt')), undefined);
	assert.equal(toRelativeLogoPath(root, root), undefined);
});

test('logoPathFromDrop takes the first image inside the root from URIs or absolute paths', () => {
	const root = path.join(path.sep, 'work', 'repo');
	const logo = path.join(root, 'assets', 'logo.png');
	assert.deepEqual(logoPathFromDrop(root, [pathToFileURL(logo).href]), { ok: true, path: 'assets/logo.png' });
	assert.deepEqual(logoPathFromDrop(root, [logo]), { ok: true, path: 'assets/logo.png' });
	assert.deepEqual(
		logoPathFromDrop(root, ['# comment', 'https://example.com/a.png', pathToFileURL(path.join(root, 'README.md')).href, logo]),
		{ ok: true, path: 'assets/logo.png' },
	);
});

test('logoPathFromDrop says why nothing was usable', () => {
	const root = path.join(path.sep, 'work', 'repo');
	assert.deepEqual(logoPathFromDrop(root, [path.join(root, 'notes.txt')]), { ok: false, reason: 'type' });
	assert.deepEqual(logoPathFromDrop(root, [path.join(root, '..', 'other', 'logo.png')]), { ok: false, reason: 'outside' });
	assert.deepEqual(
		logoPathFromDrop(root, [path.join(path.sep, 'tmp', 'a.png'), path.join(root, 'notes.txt')]),
		{ ok: false, reason: 'type' },
	);
	for (const bad of [undefined, 'a.png', [], ['relative/a.png', 'https://example.com/a.png', 42, `${root}/a.png\0`]]) {
		assert.deepEqual(logoPathFromDrop(root, bad), { ok: false, reason: 'none' }, String(bad));
	}
});

test('normalizeLogoLocations', () => {
	assert.deepEqual(normalizeLogoLocations(undefined), ['identityCard', 'explorerItem', 'scmCard']);
	assert.deepEqual(normalizeLogoLocations(['windowTitle', 'bogus', 'identityCard']), ['identityCard', 'windowTitle']);
	assert.deepEqual(normalizeLogoLocations(['windowTitle', 'scmCard']), ['scmCard', 'windowTitle']);
	assert.deepEqual(normalizeLogoLocations([]), []);
});

test('normalizeTitlePrefix trims, strips variables and limits length', () => {
	assert.equal(normalizeTitlePrefix('  🟦 '), '🟦');
	assert.equal(normalizeTitlePrefix('${rootName}X'), 'X');
	assert.equal(normalizeTitlePrefix('abcdefghijkl'), 'abcdefgh');
	assert.equal(normalizeTitlePrefix(5), '');
});

test('buildWindowTitle prefixes the template', () => {
	assert.equal(buildWindowTitle('🟦', undefined), `🟦 ${DEFAULT_TITLE_TEMPLATE}`);
	assert.equal(buildWindowTitle('X', '${rootName}'), 'X ${rootName}');
	assert.equal(buildWindowTitle('', '${rootName}'), undefined);
});

test('isGeneratedTitle recognizes our own prefixed titles only', () => {
	assert.equal(isGeneratedTitle(`🟦 ${DEFAULT_TITLE_TEMPLATE}`, undefined), true);
	assert.equal(isGeneratedTitle('X ${rootName}', '${rootName}'), true);
	assert.equal(isGeneratedTitle('${rootName}', '${rootName}'), false);
	assert.equal(isGeneratedTitle('my custom title', '${rootName}'), false);
	assert.equal(isGeneratedTitle('way too long prefix ${rootName}', '${rootName}'), false);
	assert.equal(isGeneratedTitle(undefined, undefined), false);
});
