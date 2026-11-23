import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHashSet, parseRecentCommits } from '../src/gitLog.ts';

const line = (hash: string, seconds: number, subject: string) => `${hash}\x1f${seconds}\x1f${subject}`;

test('parseRecentCommits reads hash, time and subject, newest first as given', () => {
	const out = [line('abc1234', 100, 'Fix login'), line('def5678', 50, 'Add card')].join('\n') + '\n';
	assert.deepEqual(parseRecentCommits(out), [
		{ hash: 'abc1234', title: 'Fix login', updatedAt: 100_000 },
		{ hash: 'def5678', title: 'Add card', updatedAt: 50_000 },
	]);
});

test('parseRecentCommits honors the limit, skips junk and truncates long subjects', () => {
	const long = 'x'.repeat(200);
	const out = ['garbage', line('aaaa111', 1, long), line('bbbb222', 2, 'two'), line('cccc333', 3, 'three')].join('\n');
	const commits = parseRecentCommits(out, 2);
	assert.equal(commits.length, 2);
	assert.equal(commits[0].title.length, 80);
	assert.ok(commits[0].title.endsWith('\u2026'));
	assert.equal(commits[1].title, 'two');
});

test('parseRecentCommits of empty output is empty', () => {
	assert.deepEqual(parseRecentCommits(''), []);
});

test('parseHashSet keeps hashes, lowercased, and skips other lines', () => {
	assert.deepEqual([...parseHashSet('ABC1234\n\nnot a hash\ndef5678\n')], ['abc1234', 'def5678']);
});

test('parseRecentCommits marks commits missing from the local-only set as pushed', () => {
	const out = [line('aaaa111', 3, 'new'), line('bbbb222', 2, 'newer'), line('cccc333', 1, 'old')].join('\n');
	const commits = parseRecentCommits(out, 3, new Set(['aaaa111', 'bbbb222']));
	assert.deepEqual(commits.map(c => c.pushed), [false, false, true]);
});

test('parseRecentCommits leaves pushed out when the local-only set is unknown, and matches hashes case-insensitively', () => {
	assert.equal('pushed' in parseRecentCommits(line('aaaa111', 1, 'x'))[0], false);
	assert.equal(parseRecentCommits(line('AAAA111', 1, 'x'), 1, new Set(['aaaa111']))[0].pushed, false);
});
