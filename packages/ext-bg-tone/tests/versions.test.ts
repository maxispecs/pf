import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	bumpVersion,
	isTarget,
	localDate,
	parseVersionsFile,
	parseVersionsState,
	planBump,
	previewBump,
	stackBumpedSinceHead,
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

test('versionsState lists the stack first and drops the shared folder from the names', () => {
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
	assert.deepEqual(mixed.rows.map(r => r.label), ['stack', 'a/x', 'b/y']);
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

test('localDate is the local calendar day', () => {
	assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});
