import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CATEGORY_PALETTE,
	categoryCounts,
	categoryNameProblem,
	planCategorize,
	planCategoryEdit,
	validateCategoryColor,
	validateCategoryName,
} from '../src/categories.ts';
import { categoryColor, parseVersionsFile } from '../src/versions.ts';

const doc = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		stack: { version: '1.0' },
		hooks: { postSync: 'echo hi' },
		categories: { core: { color: '#4aa3ff' }, data: {}, ui: { color: '#b180d7' } },
		packages: {
			'packages/a': { version: '1.0', type: 'node', category: 'core' },
			'packages/b': { version: '1.0', type: 'node', category: 'core' },
			'packages/c': { version: '1.0', type: 'node' },
		},
		...extra,
	});

const parse = (plan: { ok: boolean; text?: string }) => JSON.parse((plan as { text: string }).text);
const order = (plan: { ok: boolean; text?: string }) => Object.keys(parse(plan).categories);

test('planCategorize sets, changes and clears a package category, and only that', () => {
	const set = planCategorize(doc(), 'packages/c', 'ui');
	assert.equal(set.ok && set.changed, true);
	assert.equal(parse(set).packages['packages/c'].category, 'ui');
	assert.equal(parse(set).packages['packages/c'].version, '1.0'); // no version change
	assert.deepEqual(Object.keys(parse(set)), ['stack', 'categories', 'hooks', 'packages']);

	assert.equal(parse(planCategorize(doc(), 'packages/a', 'data')).packages['packages/a'].category, 'data');
	const cleared = planCategorize(doc(), 'packages/a', null);
	assert.equal('category' in parse(cleared).packages['packages/a'], false);

	// Nothing to change: the text comes back as it was.
	const same = planCategorize(doc(), 'packages/a', 'core');
	assert.deepEqual(same, { ok: true, text: doc(), changed: false });
	assert.equal(planCategorize(doc(), 'packages/c', null).ok && (planCategorize(doc(), 'packages/c', null) as { changed: boolean }).changed, false);
});

test('planCategorize refuses the stack, unknown packages and categories, and a bad file', () => {
	assert.equal(planCategorize(doc(), 'stack', 'core').ok, false);
	assert.equal(planCategorize(doc(), 'packages/zzz', 'core').ok, false);
	assert.equal(planCategorize(doc(), 'packages/a', 'nope').ok, false);
	assert.equal(planCategorize(doc(), 'packages/a', 4).ok, false);
	assert.equal(planCategorize(doc(), 'packages/a', undefined).ok, false);
	assert.equal(planCategorize(doc(), 4, 'core').ok, false);
	assert.equal(planCategorize(null, 'packages/a', 'core').ok, false);
	assert.equal(planCategorize(doc({ categories: 'x' }), 'packages/a', 'core').ok, false);
});

test('add creates a category last, with an optional lowercased color', () => {
	const added = planCategoryEdit(doc(), { kind: 'add', name: 'infra', color: '#ABC' });
	assert.deepEqual(order(added), ['core', 'data', 'ui', 'infra']);
	assert.deepEqual(parse(added).categories.infra, { color: '#abc' });
	assert.deepEqual(parse(planCategoryEdit(doc(), { kind: 'add', name: 'plain' })).categories.plain, {});
	// The first category creates the key, right after the stack.
	const first = planCategoryEdit(doc({ categories: undefined }), { kind: 'add', name: 'one' });
	assert.deepEqual(Object.keys(parse(first)), ['stack', 'categories', 'hooks', 'packages']);
	for (const edit of [
		{ kind: 'add', name: 'core' },
		{ kind: 'add', name: '' },
		{ kind: 'add', name: ' padded' },
		{ kind: 'add', name: 'tab\there' },
		{ kind: 'add', name: 'x', color: 'red' },
		{ kind: 'add', name: 7 },
	] as const) {
		assert.equal(planCategoryEdit(doc(), edit as never).ok, false, JSON.stringify(edit));
	}
});

test('color sets, clears and keeps the rest of the category', () => {
	const text = doc({ categories: { core: { color: '#4aa3ff', note: 'keep' }, data: {} } });
	const set = planCategoryEdit(text, { kind: 'color', name: 'core', color: '#5CB85C' });
	assert.deepEqual(parse(set).categories.core, { color: '#5cb85c', note: 'keep' });
	assert.deepEqual(parse(planCategoryEdit(text, { kind: 'color', name: 'core', color: null })).categories.core, { note: 'keep' });
	assert.deepEqual(parse(planCategoryEdit(text, { kind: 'color', name: 'data', color: '#fff' })).categories.data, { color: '#fff' });
	const same = planCategoryEdit(text, { kind: 'color', name: 'core', color: '#4AA3FF' });
	assert.equal(same.ok && same.changed, false);
	assert.equal(planCategoryEdit(text, { kind: 'color', name: 'core', color: 'blue' }).ok, false);
	assert.equal(planCategoryEdit(text, { kind: 'color', name: 'ghost', color: '#fff' }).ok, false);
});

test('rename keeps the place in the order and moves the packages along', () => {
	const renamed = planCategoryEdit(doc(), { kind: 'rename', name: 'core', to: 'base' });
	assert.deepEqual(order(renamed), ['base', 'data', 'ui']);
	assert.deepEqual(parse(renamed).categories.base, { color: '#4aa3ff' });
	assert.equal(parse(renamed).packages['packages/a'].category, 'base');
	assert.equal(parse(renamed).packages['packages/b'].category, 'base');
	assert.equal('category' in parse(renamed).packages['packages/c'], false);
	assert.equal(planCategoryEdit(doc(), { kind: 'rename', name: 'core', to: 'core' }).ok, true);
	assert.equal((planCategoryEdit(doc(), { kind: 'rename', name: 'core', to: 'core' }) as { changed: boolean }).changed, false);
	assert.equal(planCategoryEdit(doc(), { kind: 'rename', name: 'core', to: 'ui' }).ok, false);
	assert.equal(planCategoryEdit(doc(), { kind: 'rename', name: 'core', to: ' x' }).ok, false);
	assert.equal(planCategoryEdit(doc(), { kind: 'rename', name: 'ghost', to: 'x' }).ok, false);
});

test('move swaps with the neighbour and stops at the ends', () => {
	assert.deepEqual(order(planCategoryEdit(doc(), { kind: 'move', name: 'ui', by: -1 })), ['core', 'ui', 'data']);
	assert.deepEqual(order(planCategoryEdit(doc(), { kind: 'move', name: 'core', by: 1 })), ['data', 'core', 'ui']);
	const top = planCategoryEdit(doc(), { kind: 'move', name: 'core', by: -1 });
	assert.deepEqual(top, { ok: true, text: doc(), changed: false });
	const bottom = planCategoryEdit(doc(), { kind: 'move', name: 'ui', by: 1 });
	assert.equal(bottom.ok && bottom.changed, false);
});

test('remove drops the category and clears it from its packages; the last one drops the key', () => {
	const removed = planCategoryEdit(doc(), { kind: 'remove', name: 'core' });
	assert.deepEqual(order(removed), ['data', 'ui']);
	assert.equal('category' in parse(removed).packages['packages/a'], false);
	assert.equal(planCategoryEdit(doc(), { kind: 'remove', name: 'ghost' }).ok, false);
	const last = planCategoryEdit(doc({ categories: { only: {} } }), { kind: 'remove', name: 'only' });
	assert.equal('categories' in parse(last), false);
});

test('an unknown edit or a bad file is refused', () => {
	assert.equal(planCategoryEdit(doc(), { kind: 'nope', name: 'core' } as never).ok, false);
	assert.equal(planCategoryEdit(doc(), null as never).ok, false);
	assert.equal(planCategoryEdit('garbage', { kind: 'add', name: 'x' }).ok, false);
	assert.equal(planCategoryEdit(doc({ categories: [] }), { kind: 'add', name: 'x' }).ok, false);
});

test('the file written by an edit is read back the same way, in the CLI order', () => {
	const plan = planCategoryEdit(doc({ featured: ['packages/c'] }), { kind: 'add', name: 'infra', color: '#2bb8a6' });
	const file = parseVersionsFile((plan as { text: string }).text)!;
	assert.deepEqual(file.categories.map(c => [c.name, c.color]), [['core', '#4aa3ff'], ['data', undefined], ['ui', '#b180d7'], ['infra', '#2bb8a6']]);
	assert.deepEqual(Object.keys(parse(plan)), ['stack', 'featured', 'categories', 'hooks', 'packages']);
	assert.deepEqual([...categoryCounts(file)], [['core', 2], ['data', 0], ['ui', 0], ['infra', 0]]);
});

test('names and colors typed in the pickers are checked like the CLI checks them', () => {
	assert.equal(categoryNameProblem('core'), undefined);
	assert.match(String(categoryNameProblem('')), /empty/);
	assert.match(String(categoryNameProblem(' a')), /spaces/);
	assert.equal(validateCategoryName('new', ['core']), undefined);
	assert.match(String(validateCategoryName('core', ['core'])), /already exists/);
	assert.equal(validateCategoryName('core', ['core'], 'core'), undefined); // keeping its own name on a rename
	assert.match(String(validateCategoryName('  ', [])), /^Name|^The name is empty/i);
	assert.equal(validateCategoryColor('#4aa3ff'), undefined);
	assert.equal(validateCategoryColor(' #abc '), undefined);
	assert.ok(validateCategoryColor('blue'));
	assert.ok(CATEGORY_PALETTE.every(p => categoryColor(p.color) === p.color));
});
