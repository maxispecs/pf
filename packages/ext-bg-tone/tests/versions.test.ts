import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	bumpVersion,
	commitMessage,
	hookCommands,
	isTarget,
	localDate,
	parseVersionsFile,
	parseVersionsState,
	pendingChanges,
	planBump,
	planFeature,
	previewBump,
	shortLabels,
	stackBumpedSinceHead,
	versionFileCandidates,
	versionsState,
} from '../src/versions.ts';

const FILE = `{
  "stack": { "version": "3.23", "since": "2026-11-19" },
  "packages": {
    "packages/kit": { "version": "1.4", "since": "2026-11-18", "type": "node", "note": "keep" },
    "packages/aws": { "version": "2.0", "since": "2026-11-17", "type": "node" }
  },
  "hooks": { "postSync": "echo hi" }
}
`;
const TODAY = '2026-11-20';

function plan(target: string, part: string, stackDone: boolean, text = FILE) {
	const result = planBump(text, target, part, { stackDone, today: TODAY });
	assert.equal(result.ok, true);
	return result.ok ? result : (undefined as never);
}

test('bumpVersion: major resets minor, minor adds one', () => {
	assert.equal(bumpVersion('1.4', 'major'), '2.0');
	assert.equal(bumpVersion('1.9', 'minor'), '1.10');
	assert.throws(() => bumpVersion('1', 'minor'));
});

test('parseVersionsFile reads a valid file and refuses anything else', () => {
	const file = parseVersionsFile(FILE);
	assert.equal(file?.stack.version, '3.23');
	assert.deepEqual(Object.keys(file?.packages ?? {}), ['packages/kit', 'packages/aws']);
	assert.equal(parseVersionsFile(null), undefined);
	assert.equal(parseVersionsFile('nope'), undefined);
	assert.equal(parseVersionsFile('[]'), undefined);
	assert.equal(parseVersionsFile('{"stack":{"version":"3.5.1"}}'), undefined);
	assert.equal(parseVersionsFile('{"stack":{"version":"3.5"},"packages":{"a":{"version":"x"}}}'), undefined);
	assert.equal(parseVersionsFile('{"stack":{"version":"3.5"},"packages":[]}'), undefined);
	assert.deepEqual(parseVersionsFile('{"stack":{"version":"3.5"}}')?.packages, {});
});

test('a package bump raises the stack minor once', () => {
	const result = plan('packages/kit', 'minor', false);
	assert.deepEqual(result.changes, [
		{ target: 'packages/kit', from: '1.4', to: '1.5' },
		{ target: 'stack', from: '3.23', to: '3.24' },
	]);
	const next = JSON.parse(result.text);
	assert.equal(next.packages['packages/kit'].version, '1.5');
	assert.equal(next.packages['packages/kit'].since, TODAY);
	assert.equal(next.stack.version, '3.24');
	assert.equal(next.stack.since, TODAY);
});

test('a package bump leaves the stack alone when it was already bumped', () => {
	const result = plan('packages/aws', 'major', true);
	assert.deepEqual(result.changes, [{ target: 'packages/aws', from: '2.0', to: '3.0' }]);
	const next = JSON.parse(result.text);
	assert.equal(next.stack.version, '3.23');
	assert.equal(next.stack.since, '2026-11-19');
});

test('a click on the stack always bumps the stack, once', () => {
	for (const stackDone of [false, true]) {
		const result = plan('stack', 'major', stackDone);
		assert.deepEqual(result.changes, [{ target: 'stack', from: '3.23', to: '4.0' }]);
		assert.equal(JSON.parse(result.text).packages['packages/kit'].version, '1.4');
	}
});

test('the write keeps other keys, the type and the CLI format', () => {
	const result = plan('packages/kit', 'minor', true);
	const next = JSON.parse(result.text);
	assert.equal(next.packages['packages/kit'].type, 'node');
	assert.equal(next.packages['packages/kit'].note, 'keep');
	assert.deepEqual(Object.keys(next.packages['packages/kit']), ['version', 'since', 'type', 'note']);
	assert.deepEqual(next.hooks, { postSync: 'echo hi' });
	assert.deepEqual(Object.keys(next.packages), ['packages/aws', 'packages/kit']);
	assert.ok(result.text.endsWith('}\n'));
	assert.ok(result.text.startsWith('{\n  "stack": {\n    "version"'));
});

test('planBump refuses a bad part, target, date or file', () => {
	const refused = (target: unknown, part: unknown, text: string | null = FILE, today = TODAY) =>
		planBump(text, target, part, { stackDone: false, today }).ok;
	assert.equal(refused('packages/kit', 'patch'), false);
	assert.equal(refused('packages/none', 'minor'), false);
	assert.equal(refused('__proto__', 'minor'), false);
	assert.equal(refused('toString', 'minor'), false);
	assert.equal(refused(5, 'minor'), false);
	assert.equal(refused('stack', 'minor', null), false);
	assert.equal(refused('stack', 'minor', FILE, 'today'), false);
	assert.equal(refused('stack', 'minor'), true);
});

test('isTarget accepts only the stack and own package keys', () => {
	const file = parseVersionsFile(FILE)!;
	assert.equal(isTarget(file, 'stack'), true);
	assert.equal(isTarget(file, 'packages/kit'), true);
	assert.equal(isTarget(file, 'constructor'), false);
});

test('stackBumpedSinceHead compares the stack with HEAD', () => {
	const head = '{"stack":{"version":"3.23"},"packages":{}}';
	assert.equal(stackBumpedSinceHead(head, FILE), false);
	assert.equal(stackBumpedSinceHead(head, FILE.replace('3.23', '3.24')), true);
	assert.equal(stackBumpedSinceHead(head, FILE.replace('3.23', '4.0')), true);
	// Not in HEAD (new file, no commits) or unreadable: counts as bumped, so nothing bumps the stack again.
	assert.equal(stackBumpedSinceHead(null, FILE), true);
	assert.equal(stackBumpedSinceHead('garbage', FILE), true);
});

test('previewBump says what a click does', () => {
	const file = parseVersionsFile(FILE)!;
	assert.equal(previewBump(file, 'packages/kit', 'minor', false), 'minor 1.4 -> 1.5, stack 3.23 -> 3.24');
	assert.equal(previewBump(file, 'packages/kit', 'major', true), 'major 1.4 -> 2.0 (stack already bumped since the last commit)');
	assert.equal(previewBump(file, 'stack', 'minor', true), 'minor 3.23 -> 3.24');
});

test('versionsState lists the stack first and drops the storage folder from the names', () => {
	const state = versionsState(parseVersionsFile(FILE), { stackDone: false, canBump: true });
	assert.deepEqual(state.rows.map(r => [r.target, r.label, r.version]), [
		['stack', 'stack', '3.23'],
		['packages/aws', 'aws', '2.0'],
		['packages/kit', 'kit', '1.4'],
	]);
	assert.equal(state.rows[2].since, '2026-11-18');
	assert.equal(state.rows[2].tips.minor, 'minor 1.4 -> 1.5, stack 3.23 -> 3.24');
	assert.equal(state.canBump, true);

	const mixed = versionsState(
		parseVersionsFile('{"stack":{"version":"1.0"},"packages":{"a/x":{"version":"1.0"},"b/y":{"version":"1.0"}}}'),
		{ stackDone: false, canBump: true },
	);
	assert.deepEqual(mixed.rows.map(r => r.label), ['stack', 'x', 'y']);
	assert.deepEqual(versionsState(undefined, { stackDone: false, canBump: true }).rows, []);
});

test('featured packages are listed right after the stack, in featured order, and flagged', () => {
	const text = JSON.stringify({
		stack: { version: '1.0' },
		featured: ['packages/kit', 'packages/gone', 'packages/aws'],
		packages: {
			'packages/aws': { version: '2.0', type: 'node' },
			'packages/db': { version: '1.0', type: 'node' },
			'packages/kit': { version: '1.4', type: 'node' },
		},
	});
	const file = parseVersionsFile(text)!;
	assert.deepEqual(file.featured, ['packages/kit', 'packages/aws']);
	const state = versionsState(file, { stackDone: false, canBump: true });
	assert.deepEqual(state.rows.map(r => [r.label, r.featured]), [
		['stack', false],
		['kit', true],
		['aws', true],
		['db', false],
	]);
	// A bump keeps the featured list where it is.
	const plan = planBump(text, 'packages/db', 'minor', { stackDone: true, today: TODAY });
	assert.equal(plan.ok && JSON.parse(plan.text).featured.join(), 'packages/kit,packages/gone,packages/aws');
	assert.deepEqual(Object.keys(plan.ok ? JSON.parse(plan.text) : {}), ['stack', 'featured', 'packages']);
	// A malformed featured list means nothing is featured.
	assert.deepEqual(parseVersionsFile('{"stack":{"version":"1.0"},"featured":"kit"}')?.featured, []);
	assert.deepEqual(parseVersionsFile('{"stack":{"version":"1.0"},"featured":[1]}')?.featured, []);
});

test('parseVersionsState keeps only well-formed rows', () => {
	const state = versionsState(parseVersionsFile(FILE), { stackDone: true, canBump: true, hint: 'h' });
	assert.deepEqual(parseVersionsState(JSON.parse(JSON.stringify(state))), state);
	assert.deepEqual(parseVersionsState(undefined).rows, []);
	assert.deepEqual(parseVersionsState({ rows: [{ target: 1 }, state.rows[0]] }).rows, [state.rows[0]]);
});

test('pendingChanges compares the working versions.json with HEAD', () => {
	const bumped = plan('packages/kit', 'minor', false);
	assert.deepEqual(pendingChanges(FILE, bumped.text), [
		{ target: 'stack', from: '3.23', to: '3.24' },
		{ target: 'packages/kit', from: '1.4', to: '1.5' },
	]);
	assert.equal(commitMessage(pendingChanges(FILE, bumped.text)), 'Bump versions: stack 3.23 -> 3.24, packages/kit 1.4 -> 1.5');
	// Nothing changed, no HEAD copy, or an unreadable file: nothing waits.
	assert.deepEqual(pendingChanges(FILE, FILE), []);
	assert.deepEqual(pendingChanges(null, FILE), []);
	assert.deepEqual(pendingChanges(undefined, FILE), []);
	assert.deepEqual(pendingChanges(FILE, 'nope'), []);
	// A package HEAD lacks is new, not bumped.
	const added = JSON.stringify({ stack: { version: '3.23' }, packages: { 'packages/new': { version: '1.0' }, 'packages/kit': { version: '1.4' } } });
	assert.deepEqual(pendingChanges(FILE, added), []);
});

test('versionFileCandidates lists versions.json and the manifests of the bumped targets only', () => {
	const files = versionFileCandidates(
		[{ target: 'stack', from: '1.0', to: '1.1' }, { target: 'packages/kit', from: '1.0', to: '1.1' }, { target: '../outside', from: '1.0', to: '1.1' }, { target: '/abs', from: '1.0', to: '1.1' }],
		'versions.json',
	);
	assert.ok(files.includes('versions.json') && files.includes('package.json') && files.includes('VERSION'));
	assert.ok(files.includes('packages/kit/package.json') && files.includes('packages/kit/pyproject.toml'));
	assert.equal(files.some(f => f.includes('..') || f.startsWith('/')), false);
	assert.equal(files.some(f => f.startsWith('packages/aws')), false);
});

test('hookCommands reads a string or an array and refuses a malformed hooks key', () => {
	const hooks = (value: unknown) => hookCommands(parseVersionsFile(JSON.stringify({ stack: { version: '1.0' }, hooks: value }))!, 'preCommit');
	assert.deepEqual(hooks({ preCommit: 'fmt {files}' }), { ok: true, commands: ['fmt {files}'] });
	assert.deepEqual(hooks({ preCommit: ['a', 'b'], postSync: 'x' }), { ok: true, commands: ['a', 'b'] });
	assert.deepEqual(hooks({ postSync: 'x' }), { ok: true, commands: [] });
	assert.deepEqual(hooks(undefined), { ok: true, commands: [] });
	assert.equal(hooks({ preCommit: 3 }).ok, false);
	assert.equal(hooks({ preCommit: [' '] }).ok, false);
	assert.equal(hooks({ other: 'x' }).ok, false);
	assert.equal(hooks([]).ok, false);
});

test('the pending commit survives the state round trip and is dropped when malformed', () => {
	const state = versionsState(parseVersionsFile(FILE), { stackDone: false, canBump: true, pending: { message: 'Bump versions: stack 3.23 -> 3.24' } });
	assert.deepEqual(parseVersionsState(JSON.parse(JSON.stringify(state))).pending, { message: 'Bump versions: stack 3.23 -> 3.24' });
	assert.equal(parseVersionsState({ ...state, pending: { message: 4 } }).pending, null);
	assert.equal(versionsState(parseVersionsFile(FILE), { stackDone: false, canBump: true }).pending, null);
});

test('localDate is the local calendar day', () => {
	assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});

test('planFeature adds to and removes from the featured list, like the CLI', () => {
	const doc = (featured?: string[]) =>
		JSON.stringify({
			stack: { version: '1.0' },
			...(featured ? { featured } : {}),
			hooks: { postSync: 'x' },
			packages: { 'packages/b': { version: '1.0', type: 'node' }, 'packages/a': { version: '1.0', type: 'node' } },
		});
	const on = planFeature(doc(), 'packages/b', true);
	assert.ok(on.ok && on.changed);
	const next = on.ok ? JSON.parse(on.text) : {};
	assert.deepEqual(next.featured, ['packages/b']);
	assert.deepEqual(Object.keys(next), ['stack', 'featured', 'hooks', 'packages']);
	assert.deepEqual(Object.keys(next.packages), ['packages/a', 'packages/b']);
	assert.equal(next.packages['packages/b'].version, '1.0');
	assert.equal(next.stack.version, '1.0');

	// Appended last, stale entries kept.
	const more = planFeature(doc(['packages/gone']), 'packages/a', true);
	assert.deepEqual(more.ok ? JSON.parse(more.text).featured : null, ['packages/gone', 'packages/a']);

	// Removing the last one drops the key.
	const off = planFeature(doc(['packages/a']), 'packages/a', false);
	assert.ok(off.ok && off.changed);
	assert.equal(off.ok && 'featured' in JSON.parse(off.text), false);

	// Nothing to do leaves the text alone.
	const same = planFeature(doc(['packages/a']), 'packages/a', true);
	assert.ok(same.ok && !same.changed && same.text === doc(['packages/a']));
	assert.ok(planFeature(doc(), 'packages/a', false).ok);
});

test('planFeature refuses the stack, unknown targets, odd input and a malformed list', () => {
	const text = '{"stack":{"version":"1.0"},"packages":{"packages/a":{"version":"1.0"}}}';
	assert.equal(planFeature(text, 'stack', true).ok, false);
	assert.equal(planFeature(text, 'packages/none', true).ok, false);
	assert.equal(planFeature(text, '__proto__', true).ok, false);
	assert.equal(planFeature(text, 'packages/a', 'yes').ok, false);
	assert.equal(planFeature(null, 'packages/a', true).ok, false);
	assert.equal(planFeature('{"stack":{"version":"1.0"},"featured":"a","packages":{"a":{"version":"1.0"}}}', 'a', true).ok, false);
});

test('shortLabels drops the storage folder and keeps segments only to tell packages apart', () => {
	const labels = (paths: string[]) => Object.fromEntries(shortLabels(paths));
	// A package outside packages/ (workbench) does not stop packages/ from being dropped.
	assert.deepEqual(labels(['packages/kit', 'packages/aws', 'workbench']), { 'packages/kit': 'kit', 'packages/aws': 'aws', workbench: 'workbench' });
	assert.deepEqual(labels(['apps/web', 'libs/ui', 'tools/cli/run']), { 'apps/web': 'web', 'libs/ui': 'ui', 'tools/cli/run': 'run' });
	// The same name in two folders keeps its folder; the rest stay short.
	assert.deepEqual(labels(['apps/web', 'libs/web', 'libs/ui']), { 'apps/web': 'apps/web', 'libs/web': 'libs/web', 'libs/ui': 'ui' });
	assert.deepEqual(labels(['a/x/web', 'b/x/web', 'c/y/web']), { 'a/x/web': 'a/x/web', 'b/x/web': 'b/x/web', 'c/y/web': 'y/web' });
	assert.deepEqual(labels(['.']), { '.': '.' });
});
