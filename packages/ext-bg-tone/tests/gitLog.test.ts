import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecentCommits } from '../src/gitLog.ts';

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
