import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_SNAPSHOT_KEY, CardCache, CardSnapshot, composeSnapshot, escapeAttribute, NO_ACTIONS, parseSnapshot } from '../src/cardCache.ts';

const cached: CardSnapshot = {
	name: 'old',
	version: '3.5',
	color: '#111111',
	logo: { uri: 'file:///repo/logo.svg', mtime: 1 },
	agents: [{ title: 'Fix login', status: 'success', updatedAt: 5 }],
	actions: { buttons: [{ id: 'dev', label: 'Run', icon: 'play' }], canEdit: true, hint: '' },
};

function memento(initial?: unknown) {
	const writes: unknown[] = [];
	return {
		writes,
		get: (key: string) => (key === CARD_SNAPSHOT_KEY ? initial : undefined),
		update: async (_key: string, value: unknown) => {
			writes.push(value);
		},
	};
}

test('composeSnapshot keeps the cached parts that have not loaded yet', () => {
	const s = composeSnapshot({ name: 'new', version: '3.6', color: '#222222', logo: undefined, agents: undefined, actions: undefined }, cached);
	assert.equal(s.name, 'new');
	assert.equal(s.version, '3.6');
	assert.equal(s.color, '#222222');
	assert.deepEqual(s.logo, cached.logo);
	assert.deepEqual(s.agents, cached.agents);
	assert.deepEqual(s.actions, cached.actions);
});

test('composeSnapshot: a loaded "nothing" replaces the cache', () => {
	const s = composeSnapshot({ name: 'n', version: '', color: '', logo: null, agents: [], actions: NO_ACTIONS }, cached);
	assert.equal(s.logo, null);
	assert.deepEqual(s.agents, []);
	assert.deepEqual(s.actions, NO_ACTIONS);
});

test('composeSnapshot without a cache falls back to empty parts', () => {
	const s = composeSnapshot({ name: 'n', version: '', color: '', logo: undefined, agents: undefined, actions: undefined }, undefined);
	assert.deepEqual(s, { name: 'n', version: '', color: '', logo: null, agents: [], actions: NO_ACTIONS });
});

test('parseSnapshot accepts a stored snapshot and rejects anything else', () => {
	assert.deepEqual(parseSnapshot(cached), cached);
	assert.equal(parseSnapshot(undefined), undefined);
	assert.equal(parseSnapshot({ name: 'x' }), undefined);
	// A snapshot stored by an older version has no version.
	const { version: _version, ...old } = cached;
	assert.equal(parseSnapshot(old)?.version, '');
	assert.equal(parseSnapshot({ ...cached, logo: { uri: 1 } })?.logo, null);
});

test('CardCache loads from the memento and writes only a changed snapshot', () => {
	const m = memento(cached);
	const cache = new CardCache(m);
	assert.deepEqual(cache.snapshot, cached);
	cache.set({ ...cached });
	assert.equal(m.writes.length, 0);
	cache.set({ ...cached, name: 'new' });
	assert.equal(m.writes.length, 1);
	assert.equal(cache.snapshot?.name, 'new');
});

test('escapeAttribute makes JSON safe inside a double-quoted attribute', () => {
	assert.equal(escapeAttribute('{"a":"<b>&"}'), '{&quot;a&quot;:&quot;&lt;b&gt;&amp;&quot;}');
});
