import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editSection, parseSection, pickConfigFile } from '../src/repoConfig.ts';

test('pickConfigFile prefers pulpfixer.json and falls back to an unconverted pf.json', () => {
	assert.equal(pickConfigFile(() => false), 'pulpfixer.json');
	assert.equal(pickConfigFile(n => n === 'pf.json'), 'pf.json');
	assert.equal(pickConfigFile(() => true), 'pulpfixer.json');
});

test('parseSection reads the bgTone object and says why a file is unusable', () => {
	assert.deepEqual(parseSection(null), { type: 'none' });
	assert.deepEqual(parseSection('  \n'), { type: 'none' });
	assert.deepEqual(parseSection('{"id":"x"}'), { type: 'none' });
	assert.deepEqual(parseSection('{"bgTone":{"color":"#fff"}}'), { type: 'section', values: { color: '#fff' } });
	assert.equal(parseSection('{ nope').type, 'invalid');
	assert.equal(parseSection('[1]').type, 'invalid');
	assert.equal(parseSection('{"bgTone":3}').type, 'invalid');
});

test('editSection creates the file content when there is none', () => {
	assert.deepEqual(editSection(null, { color: '#3b82f6' }), { ok: true, text: '{\n  "bgTone": {\n    "color": "#3b82f6"\n  }\n}\n' });
	assert.deepEqual(editSection(null, { color: undefined }), { ok: true, text: '' });
});

test('editSection keeps other keys, the indentation and the trailing newline', () => {
	const text = '{\n\t"id": "repo-1",\n\t"commands": { "x": "y" }\n}\n';
	const r = editSection(text, { color: '#3b82f6', logo: 'assets/logo.svg' });
	assert.ok(r.ok);
	assert.equal(r.text, '{\n\t"id": "repo-1",\n\t"commands": {\n\t\t"x": "y"\n\t},\n\t"bgTone": {\n\t\t"color": "#3b82f6",\n\t\t"logo": "assets/logo.svg"\n\t}\n}\n');
	assert.deepEqual(JSON.parse(r.text), { id: 'repo-1', commands: { x: 'y' }, bgTone: { color: '#3b82f6', logo: 'assets/logo.svg' } });
	const noNewline = editSection('{"id":"a"}', { color: '#fff' });
	assert.ok(noNewline.ok && !noNewline.text.endsWith('\n'));
});

test('editSection updates and removes keys, and drops an emptied section', () => {
	const text = JSON.stringify({ id: 'a', bgTone: { color: '#111111', logo: 'l.svg' } }, null, 2) + '\n';
	const changed = editSection(text, { color: '#222222' });
	assert.ok(changed.ok);
	assert.deepEqual(JSON.parse(changed.text).bgTone, { color: '#222222', logo: 'l.svg' });
	const cleared = editSection(text, { color: undefined, logo: undefined });
	assert.ok(cleared.ok);
	assert.deepEqual(JSON.parse(cleared.text), { id: 'a' });
});

test('editSection refuses text it cannot edit safely', () => {
	assert.equal(editSection('{ "id": ', { color: '#fff' }).ok, false);
	assert.equal(editSection('[]', { color: '#fff' }).ok, false);
	assert.equal(editSection('{"bgTone": []}', { color: '#fff' }).ok, false);
});

test('editSection ignores a __proto__ key', () => {
	const r = editSection('{}', { __proto__: 1, color: '#fff' } as Record<string, unknown>);
	assert.ok(r.ok);
	assert.deepEqual(JSON.parse(r.text), { bgTone: { color: '#fff' } });
});
