import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_SNAPSHOT_KEY, CardCache, CardSnapshot, composeSnapshot, escapeAttribute, NO_ACTIONS, parseSnapshot } from '../src/cardCache.ts';
import { NO_VERSIONS } from '../src/versions.ts';

const cached: CardSnapshot = {
	name: 'old',
	version: '3.5',
	changes: 4,
	color: '#111111',
	logo: { uri: 'file:///repo/logo.svg', mtime: 1 },
	agents: [{ title: 'Fix login', status: 'success', updatedAt: 5 }],
	commits: [{ hash: 'abc1234', title: 'Fix login bug', updatedAt: 6 }],
	actions: { buttons: [{ id: 'dev', label: 'Run', icon: 'play' }], canEdit: true, hint: '' },
	versions: {
		rows: [{ target: 'stack', label: 'stack', version: '3.5', since: '2026-11-17', featured: false, tips: { major: 'major 3.5 -> 4.0', minor: 'minor 3.5 -> 3.6' } }],
		canBump: true,
		stackDone: false,
		hint: '',
	},
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
	const s = composeSnapshot({ name: 'new', version: '3.6', changes: undefined, color: '#222222', logo: undefined, agents: undefined, commits: undefined, actions: undefined, versions: undefined }, cached);
	assert.equal(s.name, 'new');
	assert.equal(s.version, '3.6');
	assert.equal(s.changes, 4);
	assert.equal(s.color, '#222222');
	assert.deepEqual(s.logo, cached.logo);
	assert.deepEqual(s.agents, cached.agents);
	assert.deepEqual(s.commits, cached.commits);
	assert.deepEqual(s.actions, cached.actions);
	assert.deepEqual(s.versions, cached.versions);
});

test('composeSnapshot: a loaded "nothing" replaces the cache', () => {
	const s = composeSnapshot({ name: 'n', version: '', changes: null, color: '', logo: null, agents: [], commits: [], actions: NO_ACTIONS, versions: NO_VERSIONS }, cached);
	assert.equal(s.logo, null);
	assert.deepEqual(s.agents, []);
	assert.deepEqual(s.commits, []);
	assert.deepEqual(s.actions, NO_ACTIONS);
	assert.deepEqual(s.versions, NO_VERSIONS);
});

test('composeSnapshot without a cache falls back to empty parts', () => {
	const s = composeSnapshot({ name: 'n', version: '', changes: null, color: '', logo: undefined, agents: undefined, commits: undefined, actions: undefined, versions: undefined }, undefined);
	assert.deepEqual(s, { name: 'n', version: '', changes: null, color: '', logo: null, agents: [], commits: [], actions: NO_ACTIONS, versions: NO_VERSIONS });
});

test('parseSnapshot accepts a stored snapshot and rejects anything else', () => {
	assert.deepEqual(parseSnapshot(cached), cached);
	assert.equal(parseSnapshot(undefined), undefined);
	assert.equal(parseSnapshot({ name: 'x' }), undefined);
	// A snapshot stored by an older version has no version or change count.
	const { version: _version, changes: _changes, ...old } = cached;
	assert.equal(parseSnapshot(old)?.version, '');
	assert.equal(parseSnapshot(old)?.changes, null);
	assert.equal(parseSnapshot({ ...cached, changes: -1 })?.changes, null);
	assert.equal(parseSnapshot({ ...cached, logo: { uri: 1 } })?.logo, null);
	// ...nor a versions list.
	const { versions: _versions, ...older } = cached;
	assert.deepEqual(parseSnapshot(older)?.versions, NO_VERSIONS);
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
