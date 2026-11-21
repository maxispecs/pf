import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseTranscript, projectSlug, readLastChat, requestFromUserText } from '../src/chats.js';

const ID1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const ID2 = '22222222-aaaa-4bbb-8ccc-000000000002';

const user = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
const assistant = (text: string) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
const wrap = (q: string) => `<timestamp>Friday</timestamp>\n<user_query>\n${q}\n</user_query>`;

function mkHome(folder: string, chats: Record<string, string[]>, mtimes: Record<string, number> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-chats-'));
  for (const [id, lines] of Object.entries(chats)) {
    const dir = path.join(home, '.cursor', 'projects', projectSlug(folder), 'agent-transcripts', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    if (mtimes[id]) fs.utimesSync(file, mtimes[id] / 1000, mtimes[id] / 1000);
  }
  return home;
}

test('projectSlug follows Cursor project folder naming', () => {
  assert.equal(projectSlug('/Users/me/my-repo'), 'Users-me-my-repo');
  assert.equal(projectSlug('/Users/me/my repo_x', false), 'Users-me-my-repo-x');
  assert.equal(projectSlug('/Users/me//my  repo'), 'Users-me-my-repo');
});

test('requestFromUserText keeps the user_query and drops wrapper tags', () => {
  assert.equal(requestFromUserText(wrap('fix the login')), 'fix the login');
  assert.equal(requestFromUserText('<attached_files>x</attached_files> plain ask [Image]'), 'plain ask');
});

test('parseTranscript collects requests and the last assistant text, skipping broken lines', () => {
  const raw = [user(wrap('first')), assistant('one'), '{"role":"user","mess', user(wrap('second')), assistant('two'), '{"type":"turn_ended"}'].join('\n');
  assert.deepEqual(parseTranscript(raw), { requests: ['first', 'second'], answer: 'two' });
});

test('readLastChat picks the newest chat and its last answer', () => {
  const folder = '/work/my-repo';
  const home = mkHome(
    folder,
    { [ID1]: [user(wrap('old ask')), assistant('old answer')], [ID2]: [user(wrap('new ask')), assistant('thinking'), assistant('new answer')] },
    { [ID1]: 1_000_000, [ID2]: 2_000_000 },
  );
  const chat = readLastChat(folder, { home });
  assert.equal(chat?.id, ID2);
  assert.deepEqual(chat?.requests, ['new ask']);
  assert.equal(chat?.answer, 'new answer');
  assert.equal(readLastChat(folder, { home, id: ID1 })?.requests[0], 'old ask');
});

test('readLastChat returns null without transcripts, for a chat with no request, and for a bad id', () => {
  const folder = '/work/none';
  assert.equal(readLastChat(folder, { home: fs.mkdtempSync(path.join(os.tmpdir(), 'pf-chats-')) }), null);
  assert.equal(readLastChat(folder, { home: mkHome(folder, { [ID1]: [assistant('only an answer')] }) }), null);
  const home = mkHome(folder, { [ID1]: [user(wrap('ask'))] });
  assert.equal(readLastChat(folder, { home, id: '../../etc/passwd' }), null);
  assert.equal(readLastChat(folder, { home, id: ID2 }), null);
});
