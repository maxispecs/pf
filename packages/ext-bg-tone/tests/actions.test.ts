import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLine, diffFeatured, parseAction, parseActions, quoteArg, statusNotice } from '../src/actions.ts';

const doc = (actions: unknown[], over: Record<string, unknown> = {}) =>
	JSON.stringify({ schema: 1, repo: 'arbiter', actions, ...over });

const dev = { id: 'dev', label: 'Run the app locally', icon: 'play', featured: true, argv: ['dev'] };

test('parseActions reads a valid document', () => {
	const r = parseActions(doc([dev, { ...dev, id: 'build', label: 'Build', icon: 'package', featured: false, argv: ['build'] }]));
	assert.ok(r.ok);
	assert.equal(r.repo, 'arbiter');
	assert.deepEqual(r.actions.map(a => [a.id, a.icon, a.featured]), [['dev', 'play', true], ['build', 'package', false]]);
});

test('parseActions tolerates text before the JSON and refuses missing or broken output', () => {
	assert.ok(parseActions('noise\n' + doc([dev])).ok);
	assert.equal(parseActions('').ok, false);
	assert.equal(parseActions('{ nope').ok, false);
	assert.equal(parseActions('{"schema":1}').ok, false);
	assert.equal(parseActions('[]').ok, false);
});

test('parseActions refuses a schema it does not know', () => {
	const r = parseActions(doc([dev], { schema: 2 }));
	assert.equal(r.ok, false);
	assert.equal(parseActions(JSON.stringify({ actions: [dev] })).ok, false);
});

test('a bad action is dropped without hiding the others, and duplicates keep the first', () => {
	const r = parseActions(doc([
		dev,
		{ id: '', argv: ['x'] },
		{ id: 'noargv' },
		{ id: 'emptyargv', argv: [] },
		{ id: 'badarg', argv: ['a\nb'] },
		{ id: 'toomany', argv: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
		'text',
		{ ...dev, label: 'again' },
	]));
	assert.ok(r.ok);
	assert.deepEqual(r.actions.map(a => a.id), ['dev']);
	assert.equal(r.actions[0]?.label, 'Run the app locally');
});

test('parseAction falls back for a bad icon or label, and truncates long text', () => {
	assert.equal(parseAction({ id: 'a', argv: ['a'], icon: '$(rocket)' })?.icon, 'terminal');
	assert.equal(parseAction({ id: 'a', argv: ['a'], icon: 'Rocket' })?.icon, 'terminal');
	assert.equal(parseAction({ id: 'a', argv: ['a'], icon: 'cloud-upload' })?.icon, 'cloud-upload');
	assert.equal(parseAction({ id: 'a', argv: ['a'] })?.label, 'a');
	assert.equal(parseAction({ id: 'a', argv: ['a'], label: 'x'.repeat(500) })?.label.length, 120);
	assert.equal(parseAction({ id: 'a', argv: ['a'], featured: 'yes' })?.featured, false);
});

test('quoteArg leaves plain words alone and quotes everything else', () => {
	assert.equal(quoteArg('staging', 'darwin'), 'staging');
	assert.equal(quoteArg('deploy:staging', 'linux'), 'deploy:staging');
	assert.equal(quoteArg('my cmd', 'darwin'), `'my cmd'`);
	assert.equal(quoteArg(`it's`, 'darwin'), `'it'\\''s'`);
	assert.equal(quoteArg('a;rm -rf', 'linux'), `'a;rm -rf'`);
	assert.equal(quoteArg('$(x)', 'linux'), `'$(x)'`);
	assert.equal(quoteArg('a\\b', 'linux'), `'a\\b'`);
	assert.equal(quoteArg('a\\b', 'win32'), 'a\\b');
	assert.equal(quoteArg('my cmd', 'win32'), '"my cmd"');
	assert.equal(quoteArg('say "hi"', 'win32'), '"say ""hi"""');
});

test('commandLine puts pf first and quotes the path to it', () => {
	assert.equal(commandLine('pf', ['deploy', 'staging'], 'darwin'), 'pf deploy staging');
	assert.equal(commandLine('/Users/me/my tools/pf', ['dev'], 'darwin'), `'/Users/me/my tools/pf' dev`);
	assert.equal(commandLine('pf', ['my cmd'], 'darwin'), `pf 'my cmd'`);
});

test('diffFeatured lists what the picker turned on and off', () => {
	const mk = (id: string, featured: boolean) => ({ id, label: id, icon: 'terminal', featured, argv: [id] });
	const all = [mk('dev', true), mk('doc', true), mk('build', false), mk('test', false)];
	assert.deepEqual(diffFeatured(all, ['dev', 'build']), { feature: ['build'], unfeature: ['doc'] });
	assert.deepEqual(diffFeatured(all, ['dev', 'doc']), { feature: [], unfeature: [] });
	assert.deepEqual(diffFeatured(all, []), { feature: [], unfeature: ['dev', 'doc'] });
});

test('statusNotice explains what stops the list and is empty when it is usable', () => {
	assert.equal(statusNotice({ type: 'ready' }), '');
	assert.equal(statusNotice({ type: 'loading' }), '');
	assert.match(statusNotice({ type: 'no-pf' }), /pf was not found/);
	assert.match(statusNotice({ type: 'old-pf' }), /pf update/);
	assert.match(statusNotice({ type: 'unavailable', reason: 'workspace not trusted' }), /workspace not trusted/);
	assert.match(statusNotice({ type: 'error', reason: 'boom' }), /boom/);
});
