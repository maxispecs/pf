import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ElicitResult, Tool, ToolSession } from '@pulpfixer/kit/agent-tool';
import { buildContext } from '@pulpfixer/kit/context';
import { AWS_AGENT_TOOLS } from '../src/agent-tools.js';
import { liveGrants } from '../src/grants.js';
import { awsPlugin } from '../src/index.js';
import { json, mkRepo } from './helpers.js';

const tool = (name: string): Tool => AWS_AGENT_TOOLS.find((t) => t.name === name)!;

const SERVICES = JSON.stringify({ services: [{ serviceName: 'api', status: 'ACTIVE' }], taskDefinition: { environment: [{ name: 'DB_PASSWORD', value: 'hunter2' }] } });

/** A fake `aws` on PATH that logs its argv and answers sts and ecs. */
function fakeAws(account: string): { bin: string; log: string } {
  const dir = mkRepo({});
  const log = path.join(dir, 'calls.log');
  const script = `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "sts get-caller-identity") printf '%s' '{"Account":"${account}","Arn":"arn:aws:sts::${account}:assumed-role/ro/me","UserId":"X"}' ;;
  "ecs describe-services") printf '%s' '${SERVICES}' ;;
  *) echo "unexpected" >&2; exit 1 ;;
esac
`;
  fs.writeFileSync(path.join(dir, 'aws'), script, { mode: 0o755 });
  return { bin: dir, log };
}

interface Setup {
  ctx: ReturnType<typeof buildContext>;
  log: string;
  events: Record<string, unknown>[];
  restore: () => void;
}

function setup(opts: { account?: string; pinned?: string; repo?: Record<string, unknown> } = {}): Setup {
  const prev = { home: process.env.PF_HOME, path: process.env.PATH, profile: process.env.PF_PROFILE };
  const home = mkRepo({
    'config.json': json({
      profiles: { acme: { aws: { profile: 'acme-ro', account: opts.pinned ?? '123456789012', region: 'eu-west-1' }, agent: { aws: { scopes: ['identity', 'ecs', 'logs'] } } } },
    }),
  });
  const fake = fakeAws(opts.account ?? '123456789012');
  process.env.PF_HOME = home;
  process.env.PATH = `${fake.bin}${path.delimiter}${prev.path}`;
  delete process.env.PF_PROFILE;
  const repo = mkRepo({ '.git/HEAD': '', 'pf.json': json({ profile: 'acme', ...(opts.repo ?? {}) }) });
  return {
    ctx: buildContext(repo),
    log: fake.log,
    events: [],
    restore() {
      for (const [k, v] of [['PF_HOME', prev.home], ['PATH', prev.path], ['PF_PROFILE', prev.profile]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function session(s: Setup, answer: ElicitResult | null, trustClientPrompt = false): ToolSession & { asked: string[] } {
  const asked: string[] = [];
  return {
    id: `s-${Math.random().toString(16).slice(2)}`,
    asked,
    trustClientPrompt,
    ...(answer ? { elicit: async (message: string) => (asked.push(message), answer) } : {}),
    audit: (e) => void s.events.push(e),
  };
}

const APPROVE: ElicitResult = { action: 'accept', content: { approve: true } };

test('the aws plugin serves its agent tools', () => {
  const s = setup();
  try {
    assert.deepEqual(awsPlugin.tools!(s.ctx).map((t) => t.name), ['pf_aws_profile', 'pf_aws_request_access', 'pf_aws_whoami', 'pf_aws_describe']);
    assert.equal(tool('pf_aws_request_access').asksUser, true);
    assert.equal(tool('pf_aws_request_access').readOnly, false);
  } finally {
    s.restore();
  }
});

test('request, approve in the dialog, then read within the grant', async () => {
  const s = setup();
  try {
    const sess = session(s, APPROVE);
    const before = await tool('pf_aws_describe').run(s.ctx, { service: 'ecs', operation: 'describe-services' }, sess);
    assert.equal(before.ok, false);
    assert.match(before.text, /No live AWS grant/);

    const profile = await tool('pf_aws_profile').run(s.ctx, {}, sess);
    assert.match(profile.text, /pf profile: acme \(from pf\.json\)/);
    assert.match(profile.text, /123456789012 \(pinned\)/);

    const granted = await tool('pf_aws_request_access').run(s.ctx, { scopes: ['ecs'], reason: 'api returns 502', ttlMinutes: 15 }, sess);
    assert.equal(granted.ok, true, granted.text);
    assert.match(sess.asked[0]!, /Profile: acme .*AWS profile acme-ro, account 123456789012/);
    assert.match(sess.asked[0]!, /Scopes: identity, ecs/);
    assert.match(sess.asked[0]!, /Reason: api returns 502/);
    assert.equal(liveGrants()[0]!.approvedBy, 'dialog');

    const read = await tool('pf_aws_describe').run(s.ctx, { service: 'ecs', operation: 'describe-services', params: { cluster: 'web', services: ['api'] } }, sess);
    assert.equal(read.ok, true, read.text);
    assert.match(read.text, /"serviceName": "api"/);
    assert.doesNotMatch(read.text, /hunter2/);
    const calls = fs.readFileSync(s.log, 'utf8');
    assert.match(calls, /sts get-caller-identity --output json --profile acme-ro --region eu-west-1/);
    assert.match(calls, /ecs describe-services --cluster web --services api --output json --profile acme-ro --region eu-west-1/);

    const outside = await tool('pf_aws_describe').run(s.ctx, { service: 'logs', operation: 'filter-log-events' }, sess);
    assert.match(outside.text, /needs the "logs" scope/);
    const region = await tool('pf_aws_describe').run(s.ctx, { service: 'ecs', operation: 'list-clusters', region: 'us-east-1' }, sess);
    assert.match(region.text, /outside the grant/);
    const secret = await tool('pf_aws_describe').run(s.ctx, { service: 'secretsmanager', operation: 'get-secret-value' }, sess);
    assert.match(secret.text, /never allowed/);
    assert.ok(s.events.some((e) => e.event === 'aws-call' && e.operation === 'describe-services'));
    assert.ok(s.events.some((e) => e.event === 'aws-refused'));

    const other = await tool('pf_aws_describe').run(s.ctx, { service: 'ecs', operation: 'describe-services' }, session(s, APPROVE));
    assert.match(other.text, /No live AWS grant/, 'a grant belongs to its session');
  } finally {
    s.restore();
  }
});

test('declined, beyond the profile, or no way to ask: nothing is granted', async () => {
  const s = setup();
  try {
    const declined = await tool('pf_aws_request_access').run(s.ctx, { scopes: ['ecs'], reason: 'r' }, session(s, { action: 'decline' }));
    assert.equal(declined.ok, false);
    assert.match(declined.text, /did not approve/);
    const unticked = await tool('pf_aws_request_access').run(s.ctx, { scopes: ['ecs'], reason: 'r' }, session(s, { action: 'accept', content: { approve: false } }));
    assert.equal(unticked.ok, false);

    const wide = session(s, APPROVE);
    const beyond = await tool('pf_aws_request_access').run(s.ctx, { scopes: ['ec2'], reason: 'r' }, wide);
    assert.match(beyond.text, /does not allow ec2/);
    assert.equal(wide.asked.length, 0, 'the user is not asked for what the profile forbids');

    const noDialog = await tool('pf_aws_request_access').run(s.ctx, { scopes: ['ecs'], reason: 'r' }, session(s, null));
    assert.match(noDialog.text, /could not ask the user/);
    assert.equal(liveGrants().length, 0);

    const fallback = await tool('pf_aws_request_access').run(s.ctx, { scopes: ['ecs'], reason: 'r' }, session(s, null, true));
    assert.equal(fallback.ok, true);
    assert.equal(liveGrants()[0]!.approvedBy, 'agent-cli-prompt');

    const noReason = await tool('pf_aws_request_access').run(s.ctx, { scopes: ['ecs'] }, session(s, APPROVE));
    assert.match(noReason.text, /reason is required/);
  } finally {
    s.restore();
  }
});

test('the repo narrows the profile, and the wrong account is refused', async () => {
  const narrowed = setup({ repo: { agent: { aws: { scopes: ['logs'] } } } });
  try {
    const r = await tool('pf_aws_request_access').run(narrowed.ctx, { scopes: ['ecs'], reason: 'r' }, session(narrowed, APPROVE));
    assert.match(r.text, /does not allow ecs \(allowed: identity, logs\)/);
  } finally {
    narrowed.restore();
  }

  const wrong = setup({ account: '999999999999' });
  try {
    const sess = session(wrong, APPROVE);
    assert.equal((await tool('pf_aws_request_access').run(wrong.ctx, { scopes: ['ecs'], reason: 'r' }, sess)).ok, true);
    const who = await tool('pf_aws_whoami').run(wrong.ctx, {}, sess);
    assert.equal(who.ok, false);
    assert.match(who.text, /not the pinned account 123456789012/);
    const read = await tool('pf_aws_describe').run(wrong.ctx, { service: 'ecs', operation: 'describe-services' }, sess);
    assert.equal(read.ok, false);
    assert.doesNotMatch(fs.readFileSync(wrong.log, 'utf8'), /ecs describe-services/);
    assert.ok(wrong.events.some((e) => e.event === 'aws-account-mismatch'));
  } finally {
    wrong.restore();
  }
});
