import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectSlug, parseTitleRows, readChatTitles, readRecentAgentRuns, statusFromTail, titleFromUserText } from '../src/agentRuns.ts';

const userLine = (text: string) =>
	JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
const assistantLine = (text: string) =>
	JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text }] } });

test('projectSlug matches Cursor project folder names', () => {
	assert.equal(projectSlug('/Users/Shared/dev/repos/bg-tone-extension'), 'Users-Shared-dev-repos-bg-tone-extension');
	assert.equal(projectSlug('/Users/me/My Repo.v2'), 'Users-me-My-Repo-v2');
	assert.equal(projectSlug('/Users/me/My Repo.v2', false), 'Users-me-My-Repo-v2');
});

test('titleFromUserText extracts the query and drops wrapper tags', () => {
	const text = '[Image]\n<image_files>\n1. /tmp/a.png\n</image_files>\n<user_query>\n  fix   the\nbug \n</user_query>';
	assert.equal(titleFromUserText(text), 'fix the bug');
	assert.equal(titleFromUserText('plain text'), 'plain text');
	assert.ok(titleFromUserText('x'.repeat(200)).length <= 80);
	assert.ok(titleFromUserText('x'.repeat(200)).endsWith('\u2026'));
});

test('parseTitleRows keeps named chats and cleans the titles', () => {
	const out = [
		'0e59875a-579f-4caa-977d-91201c747952\tIcon display issue',
		'18a66647-e4a7-4e55-82c5-2b99fd96f003\t',
		'not an id\tIgnored',
		'965e0c47-084f-4b24-81e3-dd92de7ad400\t  Extension   logo design ',
		'',
	].join('\n');
	assert.deepEqual([...parseTitleRows(out)], [
		['0e59875a-579f-4caa-977d-91201c747952', 'Icon display issue'],
		['965e0c47-084f-4b24-81e3-dd92de7ad400', 'Extension logo design'],
	]);
});

test('readChatTitles resolves empty when the database is missing', async () => {
	const titles = await readChatTitles('/nonexistent/state.vscdb', ['0e59875a-579f-4caa-977d-91201c747952']);
	assert.equal(titles.size, 0);
	assert.equal((await readChatTitles('/nonexistent/state.vscdb', ["x'; drop table"])).size, 0);
});

test('statusFromTail reads turn_ended, else falls back to freshness', () => {
	const now = 1_000_000;
	const ended = (status: string) => `${assistantLine('hi')}\n${JSON.stringify({ type: 'turn_ended', status })}\n`;
	assert.equal(statusFromTail(ended('success'), now, now), 'success');
	assert.equal(statusFromTail(ended('error'), now, now), 'error');
	assert.equal(statusFromTail(ended('aborted'), now, now), 'stopped');
	assert.equal(statusFromTail(assistantLine('working'), now - 10_000, now), 'running');
	assert.equal(statusFromTail(assistantLine('working'), now - 10 * 60_000, now), 'stopped');
	assert.equal(statusFromTail('', now - 10 * 60_000, now), 'stopped');
});

test('readRecentAgentRuns returns the newest transcripts for the folder, newest first', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtone-'));
	try {
		const folder = '/Users/me/my-repo';
		const dir = path.join(home, '.cursor', 'projects', projectSlug(folder), 'agent-transcripts');
		const write = (id: string, lines: string[], mtime: number) => {
			fs.mkdirSync(path.join(dir, id), { recursive: true });
			const file = path.join(dir, id, `${id}.jsonl`);
			fs.writeFileSync(file, lines.join('\n') + '\n');
			fs.utimesSync(file, mtime / 1000, mtime / 1000);
		};
		const now = Date.now();
		write('old', [userLine('<user_query>old chat</user_query>')], now - 3_600_000);
		write(
			'new',
			[
				userLine('<user_query>\nadd last agent info\n</user_query>'),
				assistantLine('done'),
				JSON.stringify({ type: 'turn_ended', status: 'success' }),
			],
			now - 5 * 60_000,
		);

		write('mid1', [userLine('<user_query>second</user_query>')], now - 30 * 60_000);
		write('mid2', [userLine('<user_query>third</user_query>')], now - 20 * 60_000);

		const runs = readRecentAgentRuns(folder, { home, now });
		assert.deepEqual(runs.map(r => r.title), ['add last agent info', 'third', 'second']);
		assert.deepEqual(runs.map(r => r.id), ['new', 'mid2', 'mid1']);
		assert.equal(runs[0].status, 'success');
		assert.ok(Math.abs(runs[0].updatedAt - (now - 5 * 60_000)) < 1500);
		assert.equal(readRecentAgentRuns(folder, { home, now, limit: 1 }).length, 1);

		assert.deepEqual(readRecentAgentRuns('/Users/me/other', { home, now }), []);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
