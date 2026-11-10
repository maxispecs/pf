import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContext } from '@pulpfixer/kit/context';
import { stripAnsi } from '@pulpfixer/kit/ui/palette';
import { linkChoices } from '@pulpfixer/plugin-aws';
import { buildPersona } from '../src/agent/persona.js';
import { handle } from '../src/agent/mcp.js';
import { linkHelp, troubleshootPrompt } from '../src/commands/troubleshoot.js';
import { agentTools } from '../src/plugins/index.js';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const WORKFLOW = `jobs:
  d:
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/deploy
          aws-region: eu-west-1
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          service: api
          cluster: web
`;

const AWS_CONFIG = `[profile corp-ro]
sso_session = corp
sso_account_id = 123456789012
region = eu-west-1
`;

/** A pf home with an `acme` profile, an AWS config, and a fake `claude` on PATH so the agent can be chosen. */
function env(): Record<string, string> {
  const bin = mkRepo({});
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const home = mkRepo({
    'config.json': json({ profiles: { acme: { aws: { profile: 'acme-ro', account: '123456789012', region: 'eu-west-1' } } } }),
    'aws-config': AWS_CONFIG,
  });
  return { PF_HOME: home, AWS_CONFIG_FILE: path.join(home, 'aws-config'), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

function pf(cwd: string, e: Record<string, string>, ...args: string[]) {
  const full: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', ...e };
  delete full.FORCE_COLOR;
  delete full.PF_PROFILE;
  delete full.PF_AGENT;
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const ecsRepo = (extra: Record<string, string> = {}) => mkRepo({ '.git/HEAD': '', 'package.json': json({ name: 'acme-api' }), '.github/workflows/deploy.yml': WORKFLOW, ...extra });

test('pf t --dry-run: reads the deployment, resolves the profile, shows the check and the troubleshooting persona', () => {
  const e = env();
  const dir = ecsRepo({ 'pf.json': json({ profile: 'acme' }) });
  for (const name of ['t', 'troubleshoot']) {
    const r = pf(dir, e, name, '--agent', 'claude', '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Deployment \(read from this repo's files\)/);
    assert.match(r.err, /AWS accounts in the repo: 123456789012/);
    assert.match(r.err, /ECS clusters: web/);
    assert.match(r.err, /profile acme \(from pf\.json\) AWS profile acme-ro, account 123456789012, region eu-west-1/);
    assert.match(r.err, /would run aws sts get-caller-identity --output json --profile acme-ro --region eu-west-1/);
    assert.match(r.err, /Troubleshooting mode \(pf t\)/);
    assert.match(r.err, /Call pf_aws_context first/);
    assert.match(r.err, /would run claude[\s\S]*--allowedTools mcp__pulpfixer__pf_aws_context/);
    assert.match(r.err, /--allowedTools mcp__pulpfixer__pf_aws_link_profile/);
    assert.match(r.err, /- troubleshoot: Find out why a deployed service is failing/);
    assert.match(r.err, /--allowedTools mcp__pulpfixer__pf_aws_act/);
    assert.match(r.err, /troubleshooting session: call pf_skill with name "troubleshoot"/);
    assert.match(r.err, /pf v/, 'the banner is still printed');
  }
  const asked = pf(dir, e, 't', '--agent', 'claude', '--dry-run', 'api returns 502');
  assert.match(asked.err, /api returns 502/);
});

test('pf t with no profile: dry-run says it would ask, and without a terminal it prints the exact commands', () => {
  const e = env();
  const dir = ecsRepo();
  const dry = pf(dir, e, 't', '--agent', 'claude', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.err, /would ask which AWS profile this repo uses/);
  assert.match(dry.err, /no pf profile applies|No pf profile applies/);

  const r = pf(dir, e, 't', '--agent', 'claude');
  assert.equal(r.code, 2);
  assert.match(r.err, /No pf profile applies to this repo, and there is no terminal/);
  assert.match(r.err, /acme \(registered\): AWS profile acme-ro, account 123456789012/);
  assert.match(r.err, /corp-ro \(new, from ~\/\.aws\/config\)/);
  assert.match(r.err, /pf t --link/);
  assert.match(r.err, /pf profile add <name> --aws-profile acme-ro --account 123456789012 --region eu-west-1/);
  assert.equal(fs.existsSync(path.join(dir, 'pf.json')), false, 'nothing was linked');

  const link = pf(dir, e, 't', '--link');
  assert.equal(link.code, 2, 'the wizard needs a terminal');
});

test('pf t refuses outside a repo and for a profile pf does not support', () => {
  const e = env();
  const outside = pf(mkRepo({}), e, 't', '--dry-run');
  assert.equal(outside.code, 2);
  assert.match(outside.err, /pf t works inside a repo/);
  const ghost = pf(ecsRepo(), e, 't', '--profile', 'ghost', '--dry-run');
  assert.equal(ghost.code, 2);
  assert.match(ghost.err, /no profile named "ghost"/);
  assert.match(ghost.err, /only registered profiles/);
  const unregistered = pf(ecsRepo({ 'pf.json': json({ profile: 'unregistered' }) }), e, 't', '--agent', 'claude');
  assert.equal(unregistered.code, 2, 'a repo naming an unregistered profile is treated as unlinked');
  assert.match(unregistered.err, /"unregistered" \(from pf\.json\) is not configured/);
});

test('the troubleshooting persona carries the deployment and the bridge rules, and only in pf t', () => {
  const dir = ecsRepo();
  const ctx = buildContext(dir);
  const plain = buildPersona(ctx, []);
  assert.doesNotMatch(plain, /Troubleshooting mode/);
  assert.match(plain, /use pf_aws_act, never a shell/);
  const t = buildPersona(ctx, [], { troubleshoot: { deployment: ['ECS clusters: web'] } });
  assert.match(t, /Troubleshooting mode \(pf t\)/);
  assert.match(t, /ECS clusters: web/);
  assert.match(t, /call pf_aws_link_profile/);
  assert.match(t, /wait for the user to agree in the conversation/);
  assert.match(t, /If they decline, do not retry it/);
});

test('the troubleshoot prompt points at the skill, with or without a task', () => {
  assert.match(troubleshootPrompt(''), /First ask me what is going wrong/);
  assert.match(troubleshootPrompt(' 502 on api '), /^502 on api\n\n.*pf_skill with name "troubleshoot"/);
});

test('linkHelp without any profile says how to create one', () => {
  const prev = process.env.AWS_CONFIG_FILE;
  const prevHome = process.env.PF_HOME;
  process.env.AWS_CONFIG_FILE = path.join(mkRepo({}), 'none');
  process.env.PF_HOME = mkRepo({});
  try {
    const text = stripAnsi(linkHelp(linkChoices(buildContext(ecsRepo()))).join('\n'));
    assert.match(text, /aws configure sso/);
    assert.match(text, /--aws-profile <aws-profile> --account <id>/);
  } finally {
    if (prev === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = prev;
    if (prevHome === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prevHome;
  }
});

test('the mcp server reloads config, so a profile linked mid-session applies to the next call', async () => {
  const prevHome = process.env.PF_HOME;
  const prevProfile = process.env.PF_PROFILE;
  process.env.PF_HOME = mkRepo({ 'config.json': json({ profiles: { acme: { aws: { profile: 'acme-ro', account: '123456789012', region: 'eu-west-1' } } } }) });
  delete process.env.PF_PROFILE;
  try {
    const dir = ecsRepo();
    const ctx = buildContext(dir);
    const tools = agentTools(ctx);
    const call = async () => {
      const res = await handle(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pf_aws_profile', arguments: {} } }, tools);
      return (res as { result: { content: { text: string }[]; isError: boolean } }).result;
    };
    const before = await call();
    assert.equal(before.isError, true);
    assert.match(before.content[0]!.text, /No pf profile applies here/);
    fs.writeFileSync(path.join(dir, 'pf.json'), json({ profile: 'acme' }));
    const after = await call();
    assert.equal(after.isError, false, after.content[0]!.text);
    assert.match(after.content[0]!.text, /pf profile: acme \(from pf\.json\)/);
  } finally {
    if (prevHome === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prevHome;
    if (prevProfile !== undefined) process.env.PF_PROFILE = prevProfile;
  }
});
