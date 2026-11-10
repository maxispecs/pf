import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildLaunch, withPulpfixerServer } from '../src/agent/adapters.js';
import { agentInfo, resolveAgent, saveAgent, type AgentId } from '../src/agent/agents.js';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { canElicitForm, handle, serve } from '../src/agent/mcp.js';
import { agentTools } from '../src/plugins/index.js';
import { buildPersona } from '../src/agent/persona.js';
import { buildContext } from '@pulpfixer/kit/context';
import { userConfigPath } from '@pulpfixer/kit/config';
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
  assert.deepEqual(claudeLaunch.argv.slice(0, 3), ['claude', '--mcp-config', '/tmp/pf-mcp.json']);
  const systemAt = claudeLaunch.argv.indexOf('--append-system-prompt');
  assert.equal(claudeLaunch.argv[systemAt + 1], 'PERSONA');
  // Claude's --allowedTools consumes every argument until the next flag, so the task must follow
  // the single-value --append-system-prompt or the session opens with no prompt.
  assert.ok(claudeLaunch.argv.lastIndexOf('--allowedTools') < systemAt);
  assert.ok(claudeLaunch.argv.includes('--allowedTools'));
  assert.ok(claudeLaunch.argv.includes('mcp__pulpfixer__pf_commands'));
  assert.ok(!claudeLaunch.argv.includes('mcp__pulpfixer__pf_deploy_staging'));
  assert.equal(claudeLaunch.argv.at(-1), 'fix the build');
  assert.ok(!claudeLaunch.argv.includes('-p'));
  const once = buildLaunch(claude, { ...input, once: true });
  assert.deepEqual(once.argv.slice(1, 4), ['-p', '--permission-mode', 'acceptEdits']);
  assert.ok(once.argv.indexOf('--permission-mode') < once.argv.indexOf('--allowedTools'));
  assert.ok(once.argv.lastIndexOf('--allowedTools') < once.argv.indexOf('--append-system-prompt'));
  assert.equal(once.argv.at(-1), 'fix the build');
  assert.equal(buildLaunch(cursor, { ...input, once: true }).argv[1], '-p');
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

test('launch: claude may run read-only and self-asking tools unasked, and its server requires elicitation', () => {
  const ctx = buildContext(mkRepo({ '.git/HEAD': '' }));
  const launch = buildLaunch(claude, { persona: 'P', prompt: '', cwd: '/repo', tools: agentTools(ctx), profile: 'acme', mcpConfigPath: '/tmp/pf-mcp.json' });
  for (const name of ['pf_aws_profile', 'pf_aws_request_access', 'pf_aws_whoami', 'pf_aws_describe', 'pf_commands']) {
    assert.ok(launch.argv.includes(`mcp__pulpfixer__${name}`), name);
  }
  assert.ok(!launch.argv.includes('mcp__pulpfixer__pf_run'));
  const args = (JSON.parse(launch.files[0]!.contents) as { mcpServers: { pulpfixer: { args: string[] } } }).mcpServers.pulpfixer.args;
  assert.ok(args.includes('--require-elicitation'));
  assert.deepEqual(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2), ['--profile', 'acme']);
  const codexArgv = buildLaunch(codex, { persona: 'P', prompt: '', cwd: '/repo' }).argv.join(' ');
  assert.doesNotMatch(codexArgv, /require-elicitation/, 'other CLIs keep their own tool prompt as the approval');
});

test('elicitation capability: empty object or form mode', () => {
  assert.equal(canElicitForm({ elicitation: {} }), true);
  assert.equal(canElicitForm({ elicitation: { form: {}, url: {} } }), true);
  assert.equal(canElicitForm({ elicitation: { url: {} } }), false);
  assert.equal(canElicitForm({ roots: {} }), false);
});

/** Drive `serve` over in-memory stdio: send messages, wait for matching ones. */
function mcpPipe() {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: Record<string, unknown>[] = [];
  const waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
  readline.createInterface({ input: output }).on('line', (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
    else seen.push(msg);
  });
  return {
    input,
    output,
    send: (m: Record<string, unknown>) => input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'),
    next: (match: (m: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const i = seen.findIndex(match);
        if (i >= 0) resolve(seen.splice(i, 1)[0]!);
        else waiters.push({ match, resolve });
      }),
  };
}

test('mcp serve: a grant request asks the user through elicitation and is audited', async () => {
  const prev = { home: process.env.PF_HOME, profile: process.env.PF_PROFILE };
  const home = mkRepo({ 'config.json': json({ profiles: { acme: { aws: { profile: 'acme-ro', region: 'eu-west-1' } } } }) });
  process.env.PF_HOME = home;
  delete process.env.PF_PROFILE;
  try {
    const ctx = buildContext(mkRepo({ '.git/HEAD': '', 'pf.json': json({ profile: 'acme' }) }));
    const auditDir = path.join(home, 'audit');
    const pipe = mcpPipe();
    const done = serve(ctx, pipe.input, pipe.output, agentTools(ctx), { requireElicitation: true, auditDir });

    pipe.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } });
    await pipe.next((m) => m.id === 1);
    pipe.send({ id: 2, method: 'tools/call', params: { name: 'pf_aws_request_access', arguments: { scopes: ['ec2'], reason: 'disk full on web-1' } } });
    const ask = await pipe.next((m) => m.method === 'elicitation/create');
    const params = ask.params as { message: string; requestedSchema: { properties: Record<string, unknown> } };
    assert.match(params.message, /Reason: disk full on web-1/);
    assert.ok(params.requestedSchema.properties.approve);
    pipe.send({ id: ask.id, result: { action: 'accept', content: { approve: true } } });
    const granted = (await pipe.next((m) => m.id === 2)).result as { isError: boolean; content: { text: string }[] };
    assert.equal(granted.isError, false, granted.content[0]!.text);
    assert.match(granted.content[0]!.text, /Granted/);

    pipe.send({ id: 3, method: 'tools/call', params: { name: 'pf_aws_request_access', arguments: { scopes: ['ec2'], reason: 'again' } } });
    const again = await pipe.next((m) => m.method === 'elicitation/create');
    pipe.send({ id: again.id, result: { action: 'decline' } });
    const declined = (await pipe.next((m) => m.id === 3)).result as { isError: boolean };
    assert.equal(declined.isError, true);

    pipe.input.end();
    assert.equal(await done, 0);
    const [file] = fs.readdirSync(auditDir);
    const log = fs.readFileSync(path.join(auditDir, file!), 'utf8');
    assert.match(log, /"kind":"agent"/);
    assert.match(log, /"event":"aws-request"/);
    assert.match(log, /"approved":true/);
    assert.match(log, /"approved":false/);
  } finally {
    for (const [k, v] of [['PF_HOME', prev.home], ['PF_PROFILE', prev.profile]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('mcp: without an elicitation-capable client a required approval is refused', async () => {
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = mkRepo({ 'config.json': json({ profiles: { acme: { aws: { profile: 'acme-ro' } } }, defaultProfile: 'acme' }) });
  try {
    const ctx = buildContext(mkRepo({ '.git/HEAD': '' }));
    const r = await handle(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pf_aws_request_access', arguments: { scopes: ['ec2'], reason: 'r' } } }, agentTools(ctx));
    assert.ok(r && 'result' in r);
    const body = r.result as { isError: boolean; content: { text: string }[] };
    assert.equal(body.isError, true);
    assert.match(body.content[0]!.text, /could not ask the user/);
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
  }
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
  assert.match(persona, /pf_aws_request_access/);
  assert.match(persona, /never the aws CLI in a shell/);
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
  const own = mkRepo({
    'fix-failing/SKILL.md': '---\nname: fix-failing\ndescription: Registry copy.\n---\n',
    'save/SKILL.md': '---\nname: save\ndescription: Save.\n---\n',
  });
  const skills = discoverSkills(null, {}, home, bundled, null);
  assert.equal(skills.find((s) => s.name === 'pf-repo')!.description, 'User copy.');
  assert.equal(skills.find((s) => s.name === 'pf-repo')!.source, '~/.agents/skills');
  assert.equal(skills.find((s) => s.name === 'fix-failing')!.source, 'pulpfixer');
  const withOwn = discoverSkills(null, {}, home, bundled, own);
  assert.equal(withOwn.find((s) => s.name === 'fix-failing')!.source, '~/.pf/skills');
  assert.equal(withOwn.find((s) => s.name === 'save')!.source, '~/.pf/skills');

  const shipped = discoverSkills(null, {}, mkRepo({}), bundledSkillsDir(), null).map((s) => s.name);
  for (const name of ['pf-repo', 'fix-failing', 'ship-staging']) assert.ok(shipped.includes(name), name);
  assert.ok(fs.existsSync(path.join(bundledSkillsDir(), 'ship-staging', 'SKILL.md')));
});
