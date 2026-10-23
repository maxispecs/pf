import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/agent/mcp.js';
import { buildContext } from '@pulpfixer/kit/context';
import { buildHostLaunch, hostPersona } from '../src/host/agent.js';
import { parseTargets, pfHostLine, secretArgv, sendCommandArgv } from '../src/host/aws.js';
import { defaultHostConfig, defaultSecrets, parseHostConfig, validUnit } from '../src/host/config.js';
import { applySecurityCmd, detectPackageManager, listSecurityCmds, parseSecurityUpdates } from '../src/host/patch.js';
import { hostTools } from '../src/host/tools.js';

test('host config keeps well-formed values and falls back on the rest', () => {
  const c = parseHostConfig({
    region: 'eu-west-1',
    secrets: {
      NPM_TOKEN: { source: 'secretsmanager', name: 'pulpfixer/npm-token' },
      bad_name: { source: 'ssm', name: '/x' },
      OTHER: { source: 'vault', name: '/x' },
    },
    version: '3.12',
    services: ['nginx.service', '-rf', 'app@1.service'],
    maxBudgetUsd: -1,
    auditDir: 'relative/dir',
  });
  assert.equal(c.region, 'eu-west-1');
  assert.deepEqual(Object.keys(c.secrets), ['NPM_TOKEN']);
  assert.equal(c.secrets.NPM_TOKEN!.source, 'secretsmanager');
  assert.equal(c.version, '3.12');
  assert.deepEqual(c.services, ['nginx.service', 'app@1.service']);
  assert.equal(c.maxBudgetUsd, defaultHostConfig().maxBudgetUsd);
  assert.equal(c.auditDir, '/var/log/pulpfixer');
  assert.deepEqual(parseHostConfig(null), defaultHostConfig());
  assert.equal(parseHostConfig({ version: '1; rm -rf /' }).version, 'latest');
});

test('default secret names follow the source: SSM paths, Secrets Manager ids', () => {
  assert.equal(defaultSecrets('ssm', '/pf/prod/').NPM_TOKEN!.name, '/pf/prod/npm-token');
  assert.equal(defaultSecrets('secretsmanager', '/pf').ANTHROPIC_API_KEY!.name, 'pf/anthropic-api-key');
});

test('secret argv decrypts, prints only the value, and takes a region', () => {
  assert.deepEqual(secretArgv({ source: 'ssm', name: '/pf/npm-token' }, 'us-east-1'), [
    'aws', 'ssm', 'get-parameter', '--name', '/pf/npm-token', '--with-decryption', '--query', 'Parameter.Value', '--output', 'text', '--region', 'us-east-1',
  ]);
  assert.deepEqual(secretArgv({ source: 'secretsmanager', name: 'pf/key' }).slice(0, 5), ['aws', 'secretsmanager', 'get-secret-value', '--secret-id', 'pf/key']);
});

test('targets are instance ids or one tag, validated', () => {
  assert.deepEqual(parseTargets('i-0123456789abcdef0, i-0abcdef12', undefined), { instances: ['i-0123456789abcdef0', 'i-0abcdef12'] });
  assert.deepEqual(parseTargets(undefined, 'Env=staging'), { tag: { key: 'Env', value: 'staging' } });
  assert.equal(typeof parseTargets('i-1;reboot', undefined), 'string');
  assert.equal(typeof parseTargets(undefined, 'Env'), 'string');
  assert.equal(typeof parseTargets('i-0123456789abcdef0', 'Env=x'), 'string');
  assert.equal(typeof parseTargets(undefined, undefined), 'string');
});

test('send-command uses AWS-RunShellScript and quotes the remote pf line', () => {
  const line = pfHostLine(['fix', '--apply', "patch openssl'; reboot"]);
  assert.match(line, /pf host fix --apply 'patch openssl'\\''; reboot'$/);
  const argv = sendCommandArgv({ targets: { tag: { key: 'Role', value: 'web' } }, commands: [line], comment: 'pf host fix', region: 'eu-west-1' });
  assert.deepEqual(argv.slice(0, 7), ['aws', 'ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--targets', 'Key=tag:Role,Values=web']);
  const params = JSON.parse(argv[argv.indexOf('--parameters') + 1]!) as { commands: string[]; executionTimeout: string[] };
  assert.deepEqual(params.commands, [line]);
  assert.deepEqual(params.executionTimeout, ['3600']);
  assert.equal(argv.at(-1), 'eu-west-1');
});

test('package manager detection prefers dnf, then yum, then apt', () => {
  assert.equal(detectPackageManager((b) => ['dnf', 'yum'].includes(b)), 'dnf');
  assert.equal(detectPackageManager((b) => b === 'yum'), 'yum');
  assert.equal(detectPackageManager((b) => b === 'apt-get'), 'apt');
  assert.equal(detectPackageManager(() => false), null);
  assert.equal(listSecurityCmds('apt').length, 2);
});

test('security updates parse from dnf and apt output', () => {
  const dnf = [
    'ALAS2023-2025-812 important/Sec.  openssl-libs-1:3.0.8-1.amzn2023.0.18.x86_64',
    'ALAS2023-2025-812 important/Sec.  openssl-libs-1:3.0.8-1.amzn2023.0.18.x86_64',
    'ALAS2023-2025-799 medium/Sec.     curl-8.5.0-1.amzn2023.0.4.x86_64',
    'Last metadata expiration check: 0:01:02 ago',
  ].join('\n');
  const d = parseSecurityUpdates('dnf', dnf);
  assert.deepEqual(d.map((u) => u.pkg), ['openssl-libs-1:3.0.8-1.amzn2023.0.18.x86_64', 'curl-8.5.0-1.amzn2023.0.4.x86_64']);
  assert.equal(d[0]!.advisory, 'ALAS2023-2025-812 important/Sec.');
  const apt = [
    'Inst libssl3 [3.0.2-0ubuntu1.15] (3.0.2-0ubuntu1.18 Ubuntu:22.04/jammy-security [amd64])',
    'Inst vim [2:8.2.3995-1ubuntu2.15] (2:8.2.3995-1ubuntu2.16 Ubuntu:22.04/jammy-updates [amd64])',
    'Conf libssl3 (3.0.2-0ubuntu1.18 Ubuntu:22.04/jammy-security [amd64])',
  ].join('\n');
  const a = parseSecurityUpdates('apt', apt);
  assert.deepEqual(a.map((u) => u.pkg), ['libssl3']);
  assert.deepEqual(applySecurityCmd('apt', a)!.argv, ['apt-get', 'install', '-y', '-q', '--only-upgrade', 'libssl3']);
  assert.equal(applySecurityCmd('apt', []), null);
  assert.deepEqual(applySecurityCmd('dnf', d)!.argv, ['dnf', '-y', 'upgrade', '--security']);
});

test('host launch: no built-in tools, only the pf server, writes only with --apply', () => {
  const config = defaultHostConfig();
  const base = { config, task: 'patch openssl', identity: null, mcpConfigPath: '/etc/pulpfixer/mcp.json', serverArgv: ['node', 'pf.js', 'mcp', '--host'] };
  const plan = buildHostLaunch({ ...base, apply: false });
  const at = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(plan.argv[0], 'claude');
  assert.ok(plan.argv.includes('-p'));
  assert.ok(plan.argv.includes('--strict-mcp-config'));
  assert.equal(at(plan.argv, '--tools'), '');
  assert.equal(at(plan.argv, '--permission-mode'), 'dontAsk');
  assert.equal(at(plan.argv, '--max-budget-usd'), '5');
  assert.equal(plan.argv.at(-1), 'patch openssl');
  assert.doesNotMatch(at(plan.argv, '--allowedTools')!, /pf_host_patch|pf_host_restart/);
  assert.match(at(plan.argv, '--allowedTools')!, /mcp__pulpfixer__pf_host_status/);
  const apply = buildHostLaunch({ ...base, apply: true, serverArgv: ['node', 'pf.js', 'mcp', '--host', '--apply'] });
  assert.match(at(apply.argv, '--allowedTools')!, /mcp__pulpfixer__pf_host_patch/);
  assert.deepEqual(JSON.parse(apply.mcpJson).mcpServers.pulpfixer.args, ['pf.js', 'mcp', '--host', '--apply']);
  assert.match(hostPersona({ apply: false, identity: null }), /plan-only/);
});

test('host write tools refuse to act without --apply and respect the restart allowlist', async () => {
  const config = { ...defaultHostConfig(), services: ['nginx.service'] };
  const tool = (apply: boolean, name: string) => hostTools({ config, apply }).find((t) => t.name === name)!;
  const ctx = buildContext();
  const plan = await tool(false, 'pf_host_restart').run(ctx, { unit: 'nginx.service' });
  assert.equal(plan.ok, true);
  assert.match(plan.text, /Plan-only run: nothing was changed/);
  const denied = await tool(true, 'pf_host_restart').run(ctx, { unit: 'sshd.service' });
  assert.equal(denied.ok, false);
  assert.match(denied.text, /not in the restart allowlist/);
  assert.equal((await tool(true, 'pf_host_service').run(ctx, { unit: '--version' })).ok, false);
  assert.equal(validUnit('app@1.service'), true);
  assert.equal(validUnit('a b'), false);
});

test('the MCP server lists and calls the host tools it is given', async () => {
  const ctx = buildContext();
  const tools = hostTools({ config: defaultHostConfig(), apply: false });
  const list = (await handle(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools)) as { result: { tools: { name: string }[] } };
  assert.ok(list.result.tools.some((t) => t.name === 'pf_host_patch'));
  assert.ok(!list.result.tools.some((t) => t.name === 'pf_run'));
  const unknown = (await handle(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pf_run' } }, tools)) as { error?: unknown };
  assert.ok(unknown.error);
});
