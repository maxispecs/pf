import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newStreamState, renderEvent, toolDetail, toolLabel } from '../src/agent/stream.js';
import type { Palette } from '@pulpfixer/kit/ui/palette';

const id = (s: string) => s;
const off: Palette = { on: false, bold: id, dim: id, red: id, green: id, yellow: id, blue: id, magenta: id, cyan: id, brand: id, boldBrand: id, inverse: id, fg: (_n, s) => s };
const ev = (o: unknown) => JSON.stringify(o);

test('tool labels drop the pulpfixer MCP prefix and Cursor\'s ToolCall suffix', () => {
  assert.equal(toolLabel('mcp__pulpfixer__pf_skill'), 'pf_skill');
  assert.equal(toolLabel('mcp__github__get_issue'), 'github: get_issue');
  assert.equal(toolLabel('readToolCall'), 'read');
  assert.equal(toolLabel('Edit'), 'Edit');
  assert.equal(toolDetail({ file_path: '/repo/pulpfixer.json', old_string: 'x' }), '/repo/pulpfixer.json');
  assert.equal(toolDetail({ name: 'deploy-setup' }), 'deploy-setup');
  assert.equal(toolDetail('nope'), '');
});

test('Claude events: what the agent says, the tools it runs, a failed tool, the end', () => {
  const s = newStreamState();
  assert.deepEqual(renderEvent(ev({ type: 'system', subtype: 'init', model: 'opus', mcp_servers: [{ name: 'pulpfixer', status: 'connected' }] }), s, off), ['agent started (opus)']);
  assert.match(renderEvent(ev({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'pulpfixer', status: 'failed' }] }), s, off).join('\n'), /pulpfixer tools are failed/);
  const said = renderEvent(ev({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Reading the helper.\nIt deploys.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'tl' } },
    { type: 'tool_use', id: 't2', name: 'mcp__pulpfixer__pf_commands', input: {} },
  ] } }), s, off);
  assert.deepEqual(said, ['  │ Reading the helper.', '  │ It deploys.', '  ▸ Read tl', '  ▸ pf_commands']);
  assert.deepEqual(renderEvent(ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), s, off), []);
  assert.deepEqual(renderEvent(ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'no such file' }] }] } }), s, off), ['  ✗ Read: no such file']);
  assert.match(renderEvent(ev({ type: 'result', subtype: 'success', duration_ms: 12_400, num_turns: 4, total_cost_usd: 0.123 }), s, off)[0]!, /agent finished in 12s, 4 turns, \$0\.12/);
  assert.match(renderEvent(ev({ type: 'result', subtype: 'error_max_turns', is_error: true }), s, off)[0]!, /agent stopped \(error_max_turns\)/);
});

test('paths inside the working directory are shown relative to it', () => {
  const s = newStreamState('/repo');
  assert.deepEqual(renderEvent(ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/repo/pulpfixer.json' } }] } }), s, off), ['  ▸ Edit pulpfixer.json']);
});

test('Cursor events: a tool call starts, a failed one completes, a function call shows its arguments', () => {
  const s = newStreamState();
  assert.deepEqual(renderEvent(ev({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'README.md' } } } }), s, off), ['  ▸ read README.md']);
  assert.deepEqual(renderEvent(ev({ type: 'tool_call', subtype: 'completed', tool_call: { readToolCall: { args: {}, result: { success: {} } } } }), s, off), []);
  assert.deepEqual(renderEvent(ev({ type: 'tool_call', subtype: 'completed', tool_call: { editToolCall: { args: {}, result: { error: { message: 'denied' } } } } }), s, off), ['  ✗ edit: denied']);
  assert.deepEqual(renderEvent(ev({ type: 'tool_call', subtype: 'started', tool_call: { function: { name: 'mcp__pulpfixer__pf_skill', arguments: '{"name":"deploy-setup"}' } } }), s, off), ['  ▸ pf_skill deploy-setup']);
});

test('unknown events are skipped and a line that is not JSON is printed as is', () => {
  const s = newStreamState();
  assert.deepEqual(renderEvent(ev({ type: 'stream_event' }), s, off), []);
  assert.deepEqual(renderEvent('', s, off), []);
  assert.deepEqual(renderEvent('Error: not logged in', s, off), ['Error: not logged in']);
});
