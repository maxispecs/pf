import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildLaunch, withPulpfixerServer } from '../src/agent/adapters.js';
import { agentInfo, resolveAgent, saveAgent, type AgentId } from '../src/agent/agents.js';
import { handle } from '../src/agent/mcp.js';
import { buildPersona } from '../src/agent/persona.js';
import { buildContext } from '../src/context.js';
import { userConfigPath } from '../src/config.js';
import { bundledSkillsDir, discoverSkills } from '../src/skills/discover.js';
import { json, mkRepo } from './helpers.js';

const claude = agentInfo('claude')!;
const codex = agentInfo('codex')!;
const cursor = agentInfo('cursor-agent')!;
const serverArgv = ['node', 'pf.js', 'mcp', '--cwd', '/repo'];

function installed(bins: string[]) {
  return (bin: string) => bins.includes(bin);
}

test('agent ids accept aliases and reject unknown names', () => {
  assert.equal(agentInfo('claude-code')!.id, 'claude');
  assert.equal(agentInfo('cursor-agent')!.id, 'cursor');
  assert.equal(agentInfo('openai-codex')!.bin, 'codex');
  assert.equal(agentInfo('gemini'), undefined);
});

test('agent resolution: flag, then env, then config, then the first installed', () => {
  const isInstalled = installed(['claude', 'codex', 'cursor-agent']);
  assert.equal(resolveAgent({ flag: 'codex', env: 'claude', configured: 'cursor', isInstalled }).agent!.id, 'codex');
  assert.equal(resolveAgent({ env: 'cursor-agent', configured: 'claude', isInstalled }).agent!.id, 'cursor');
  assert.equal(resolveAgent({ configured: 'claude-code', isInstalled }).source, 'config');
  assert.equal(resolveAgent({ isInstalled }).agent!.id, 'cursor');
  assert.equal(resolveAgent({ isInstalled }).source, 'detected');
  const unknown = resolveAgent({ flag: 'gemini', isInstalled });
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.agent, null);
  const missing = resolveAgent({ flag: 'codex', isInstalled: installed(['claude']) });
  assert.equal(missing.missing, true);
  assert.equal(missing.agent!.id, 'codex');
  assert.equal(resolveAgent({ isInstalled: installed([]) }).source, 'none');
});

test('saveAgent merges into the user config', () => {
  const home = mkRepo({ 'config.json': json({ skillDirs: ['~/skills'] }) });
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = home;
  try {
    assert.equal(saveAgent('claude' as AgentId), true);
    const written = JSON.parse(fs.readFileSync(userConfigPath(), 'utf8')) as { agent: string; skillDirs: string[] };
    assert.equal(written.agent, 'claude');
    assert.deepEqual(written.skillDirs, ['~/skills']);
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
  }
});

test('launch argv: claude gets a system prompt, codex and cursor get the persona in front of the task', () => {
  const input = { persona: 'PERSONA', prompt: 'fix the build', cwd: '/repo', serverArgv, mcpConfigPath: '/tmp/pf-mcp.json' };
  const claudeLaunch = buildLaunch(claude, input);
  assert.deepEqual(claudeLaunch.argv.slice(0, 5), ['claude', '--mcp-config', '/tmp/pf-mcp.json', '--append-system-prompt', 'PERSONA']);
  assert.ok(claudeLaunch.argv.includes('--allowedTools'));
  assert.ok(claudeLaunch.argv.includes('mcp__pulpfixer__pf_commands'));
  assert.ok(!claudeLaunch.argv.includes('mcp__pulpfixer__pf_deploy_staging'));
  assert.equal(claudeLaunch.argv.at(-1), 'fix the build');
  const mcp = JSON.parse(claudeLaunch.files[0]!.contents) as { mcpServers: { pulpfixer: { command: string; args: string[] } } };
  assert.equal(mcp.mcpServers.pulpfixer.command, 'node');
  assert.deepEqual(mcp.mcpServers.pulpfixer.args, ['pf.js', 'mcp', '--cwd', '/repo']);

  const codexArgv = buildLaunch(codex, input).argv;
  assert.equal(codexArgv[0], 'codex');
  assert.ok(codexArgv.some((a) => a.startsWith('mcp_servers.pulpfixer.command=')));
  assert.equal(codexArgv.at(-1), 'PERSONA\n\nfix the build');

  const cursorArgv = buildLaunch(cursor, { ...input, prompt: '' }).argv;
  assert.deepEqual(cursorArgv.slice(0, 3), ['cursor-agent', '--workspace', '/repo']);
  assert.equal(cursorArgv.at(-1), 'PERSONA');
});

test('cursor mcp config keeps the other servers', () => {
  const merged = withPulpfixerServer({ mcpServers: { docs: { command: 'docs' } }, extra: true }, ['node', 'pf.js', 'mcp']);
  const servers = merged.mcpServers as Record<string, { command: string }>;
  assert.equal(servers.docs!.command, 'docs');
  assert.equal(servers.pulpfixer!.command, 'node');
  assert.equal(merged.extra, true);
});

test('the persona names the resolved commands and the safety rules', () => {
  const dir = mkRepo({
    '.git/HEAD': '',
    'package.json': json({ name: 'demo', scripts: { dev: 'vite', test: 'vitest' } }),
    'pnpm-lock.yaml': '',
  });
  const persona = buildPersona(buildContext(dir), [{ name: 'fix-failing', description: 'Get a failing test green. Then stop.', dir: '', source: 'pulpfixer' }]);
  assert.match(persona, /demo/);
  assert.match(persona, /pnpm run test/);
  assert.match(persona, /staging only, never production/);
  assert.match(persona, /\$\{NPM_TOKEN\}/);
  assert.match(persona, /Never edit versions in manifests/);
  assert.match(persona, /fix-failing/);
  assert.match(persona, /pf_skill/);
});

test('mcp: initialize, tools/list, an unknown tool, and a deploy that only plans', async () => {
  const dir = mkRepo({ '.git/HEAD': '', 'fly.staging.toml': '' });
  const ctx = buildContext(dir);
  const init = await handle(ctx, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.ok(init && 'result' in init);
  const initialized = init.result as { protocolVersion: string; capabilities: { tools: unknown } };
  assert.equal(initialized.protocolVersion, '2025-06-18');
  assert.ok(initialized.capabilities.tools);

  const listed = await handle(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(listed && 'result' in listed);
  const names = (listed.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.ok(names.includes('pf_deploy_staging'));
  assert.ok(names.includes('pf_run'));

  const missing = await handle(ctx, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } });
  assert.ok(missing && 'error' in missing);
  assert.match(missing.error.message, /Unknown tool/);

  const planned = await handle(ctx, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pf_deploy_staging', arguments: {} } });
  assert.ok(planned && 'result' in planned);
  const body = planned.result as { isError: boolean; content: { text: string }[] };
  assert.equal(body.isError, false);
  assert.match(body.content[0]!.text, /nothing was run/);
  assert.match(body.content[0]!.text, /fly deploy --config fly.staging.toml/);
});

test('bundled skills ship with pf, and an earlier skill of the same name wins', () => {
  const home = mkRepo({ '.agents/skills/pf-repo/SKILL.md': '---\nname: pf-repo\ndescription: User copy.\n---\n' });
  const bundled = mkRepo({
    'pf-repo/SKILL.md': '---\nname: pf-repo\ndescription: Bundled copy.\n---\n',
    'fix-failing/SKILL.md': '---\nname: fix-failing\ndescription: Fix.\n---\n',
  });
  const skills = discoverSkills(null, {}, home, bundled);
  assert.equal(skills.find((s) => s.name === 'pf-repo')!.description, 'User copy.');
  assert.equal(skills.find((s) => s.name === 'pf-repo')!.source, '~/.agents/skills');
  assert.equal(skills.find((s) => s.name === 'fix-failing')!.source, 'pulpfixer');

  const shipped = discoverSkills(null, {}, mkRepo({}), bundledSkillsDir()).map((s) => s.name);
  for (const name of ['pf-repo', 'fix-failing', 'ship-staging']) assert.ok(shipped.includes(name), name);
  assert.ok(fs.existsSync(path.join(bundledSkillsDir(), 'ship-staging', 'SKILL.md')));
});
