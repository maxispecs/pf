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
  "ecs update-service") printf '%s' '{"service":{"serviceName":"api","desiredCount":2}}' ;;
  *) echo "unexpected" >&2; exit 1 ;;
esac
`;
  fs.writeFileSync(path.join(dir, 'aws'), script, { mode: 0o755 });
  return { bin: dir, log };
}

interface Setup {
  ctx: ReturnType<typeof buildContext>;
  repo: string;
  log: string;
  events: Record<string, unknown>[];
  restore: () => void;
}

function setup(opts: { account?: string; pinned?: string; repo?: Record<string, unknown>; actions?: string[]; noProfile?: boolean; awsConfig?: string; files?: Record<string, string> } = {}): Setup {
  const prev = { home: process.env.PF_HOME, path: process.env.PATH, profile: process.env.PF_PROFILE, awsConfig: process.env.AWS_CONFIG_FILE };
  const home = mkRepo({
    'config.json': json({
      profiles: {
        acme: {
          aws: { profile: 'acme-ro', account: opts.pinned ?? '123456789012', region: 'eu-west-1' },
          agent: { aws: { scopes: ['identity', 'ecs', 'logs'], ...(opts.actions ? { actions: opts.actions } : {}) } },
        },
      },
    }),
    ...(opts.awsConfig !== undefined ? { 'aws-config': opts.awsConfig } : {}),
  });
  if (opts.awsConfig !== undefined) process.env.AWS_CONFIG_FILE = path.join(home, 'aws-config');
  else process.env.AWS_CONFIG_FILE = path.join(home, 'no-aws-config');
  const fake = fakeAws(opts.account ?? '123456789012');
  process.env.PF_HOME = home;
  process.env.PATH = `${fake.bin}${path.delimiter}${prev.path}`;
  delete process.env.PF_PROFILE;
  const repo = mkRepo({ '.git/HEAD': '', 'pf.json': json({ ...(opts.noProfile ? {} : { profile: 'acme' }), ...(opts.repo ?? {}) }), ...(opts.files ?? {}) });
  return {
    ctx: buildContext(repo),
    repo,
    log: fake.log,
    events: [],
    restore() {
      for (const [k, v] of [['PF_HOME', prev.home], ['PATH', prev.path], ['PF_PROFILE', prev.profile], ['AWS_CONFIG_FILE', prev.awsConfig]] as const) {
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
    assert.deepEqual(awsPlugin.tools!(s.ctx).map((t) => t.name), ['pf_aws_profile', 'pf_aws_request_access', 'pf_aws_whoami', 'pf_aws_describe', 'pf_aws_context', 'pf_aws_link_profile', 'pf_aws_act']);
    for (const name of ['pf_aws_link_profile', 'pf_aws_act']) {
      assert.equal(tool(name).asksUser, true, name);
      assert.equal(tool(name).readOnly, false, name);
    }
    assert.equal(tool('pf_aws_context').readOnly, true);
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

test('pf_aws_context: deployment, profile, scopes to request and the actions in play, with no AWS call', async () => {
  const s = setup({ files: { '.github/workflows/deploy.yml': WORKFLOW }, actions: ['ecs update-service'] });
  try {
    const r = await tool('pf_aws_context').run(s.ctx, {}, session(s, null));
    assert.equal(r.ok, true);
    assert.match(r.text, /AWS accounts in the repo: 123456789012/);
    assert.match(r.text, /ECS clusters: web/);
    assert.match(r.text, /pf profile: acme \(from pf\.json\), AWS profile acme-ro, account 123456789012 \(pinned\)/);
    assert.match(r.text, /scopes to request for this repo: identity, ecs, logs/);
    assert.match(r.text, /useful but not allowed by the profile .*: elb, cloudwatch/);
    assert.match(r.text, /fix actions enabled .*: ecs update-service/);
    assert.equal(fs.existsSync(s.log), false, 'nothing was called on AWS');
  } finally {
    s.restore();
  }

  const none = setup({ noProfile: true });
  try {
    const r = await tool('pf_aws_context').run(none.ctx, {}, session(none, null));
    assert.match(r.text, /pf profile: none/);
    assert.match(r.text, /pf_aws_link_profile/);
  } finally {
    none.restore();
  }
});

const AWS_CONFIG = `[profile corp-ro]
sso_session = corp
sso_account_id = 123456789012
region = eu-west-1

[profile other]
sso_account_id = 555555555555
`;

test('pf_aws_link_profile: the user picks, pf registers and links, and nothing happens without approval', async () => {
  const s = setup({ noProfile: true, awsConfig: AWS_CONFIG, files: { '.github/workflows/deploy.yml': WORKFLOW } });
  try {
    const picks = (profile: string, approve = true): ElicitResult => ({ action: 'accept', content: { profile, approve } });
    const none = session(s, null);
    assert.match((await tool('pf_aws_link_profile').run(s.ctx, {}, none)).text, /could not ask the user.*pf t --link/);

    const declined = session(s, { action: 'decline' });
    const d = await tool('pf_aws_link_profile').run(s.ctx, { reason: 'api is down' }, declined);
    assert.equal(d.ok, false);
    assert.match(d.text, /did not link/);
    assert.match(declined.asked[0]!, /Reason: api is down/);
    assert.match(declined.asked[0]!, /accounts 123456789012; regions eu-west-1/);
    // the profile registered in the user's config matches the repo's account, then the AWS profile in that account
    assert.match(declined.asked[0]!, /- acme \(registered\): AWS profile acme-ro, account 123456789012.*Matches: account 123456789012 appears in the repo/);
    assert.match(declined.asked[0]!, /- corp-ro \(new, from ~\/\.aws\/config\)/);
    assert.equal(JSON.parse(fs.readFileSync(`${s.repo}/pf.json`, 'utf8')).profile, undefined);

    const unticked = await tool('pf_aws_link_profile').run(s.ctx, {}, session(s, picks('acme (registered)', false)));
    assert.equal(unticked.ok, false);
    const bogus = await tool('pf_aws_link_profile').run(s.ctx, {}, session(s, picks('not offered')));
    assert.equal(bogus.ok, false);

    const sess = session(s, picks('acme (registered)'));
    const ok = await tool('pf_aws_link_profile').run(s.ctx, {}, sess);
    assert.equal(ok.ok, true, ok.text);
    assert.match(ok.text, /Linked pf profile "acme" and saved it to this repo's pf\.json/);
    assert.equal(JSON.parse(fs.readFileSync(`${s.repo}/pf.json`, 'utf8')).profile, 'acme');
    assert.equal(s.ctx.config.profile, 'acme', 'the context reloads');
    assert.ok(s.events.some((e) => e.event === 'aws-link' && e.profile === 'acme' && e.registered === false));
    const profile = await tool('pf_aws_profile').run(s.ctx, {}, sess);
    assert.match(profile.text, /pf profile: acme/);
  } finally {
    s.restore();
  }

  const fresh = setup({ noProfile: true, awsConfig: AWS_CONFIG });
  try {
    const r = await tool('pf_aws_link_profile').run(fresh.ctx, {}, session(fresh, { action: 'accept', content: { profile: 'other (new, from ~/.aws/config)', approve: true } }));
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /Linked pf profile "other" \(registered just now\)/);
    const saved = JSON.parse(fs.readFileSync(`${process.env.PF_HOME}/config.json`, 'utf8'));
    assert.deepEqual(saved.profiles.other, { aws: { profile: 'other', account: '555555555555' } });
    assert.equal(JSON.parse(fs.readFileSync(`${fresh.repo}/pf.json`, 'utf8')).profile, 'other');
    assert.equal(process.env.PF_PROFILE, 'other', 'this agent session uses it');
  } finally {
    fresh.restore();
  }

  const empty = setup({ noProfile: true });
  try {
    fs.writeFileSync(`${process.env.PF_HOME}/config.json`, '{}');
    const r = await tool('pf_aws_link_profile').run(buildContext(empty.repo), {}, session(empty, { action: 'accept', content: {} }));
    assert.match(r.text, /No AWS profiles are available/);
  } finally {
    empty.restore();
  }
});

test('pf_aws_act: needs an enabled action, a pinned account and the user\'s approval of each exact call', async () => {
  const ACT = { service: 'ecs', operation: 'update-service', params: { cluster: 'web', service: 'api', 'force-new-deployment': true }, reason: 'stuck deployment, tasks never became healthy' };
  const off = setup();
  try {
    const sess = session(off, APPROVE);
    const r = await tool('pf_aws_act').run(off.ctx, ACT, sess);
    assert.match(r.text, /not enabled for this profile/);
    assert.equal(sess.asked.length, 0);
    assert.equal(fs.existsSync(off.log), false);
  } finally {
    off.restore();
  }

  const s = setup({ actions: ['ecs update-service', 'ec2 reboot-instances'] });
  try {
    const noReason = await tool('pf_aws_act').run(s.ctx, { ...ACT, reason: '' }, session(s, APPROVE));
    assert.match(noReason.text, /reason is required/);
    const noDialog = await tool('pf_aws_act').run(s.ctx, ACT, session(s, null, true));
    assert.equal(noDialog.ok, false);
    assert.match(noDialog.text, /fix actions need pf's own dialog/);
    const declined = session(s, { action: 'decline' });
    assert.match((await tool('pf_aws_act').run(s.ctx, ACT, declined)).text, /did not approve this action/);
    assert.match(declined.asked[0]!, /CHANGE something on AWS/);
    assert.match(declined.asked[0]!, /Command: aws ecs update-service --cluster web --service api --force-new-deployment --output json --profile acme-ro --region eu-west-1/);
    assert.match(declined.asked[0]!, /account 123456789012 \(verified\)/);
    assert.match(declined.asked[0]!, /Reason: stuck deployment/);
    const unticked = await tool('pf_aws_act').run(s.ctx, ACT, session(s, { action: 'accept', content: { approve: false } }));
    assert.equal(unticked.ok, false);
    assert.doesNotMatch(fs.readFileSync(s.log, 'utf8'), /update-service/, 'nothing ran without approval');

    const bad = await tool('pf_aws_act').run(s.ctx, { ...ACT, params: { cluster: 'web', service: 'api', 'deployment-configuration': 'x', 'force-new-deployment': true } }, session(s, APPROVE));
    assert.match(bad.text, /not accepted by aws ecs update-service/);
    const outside = await tool('pf_aws_act').run(s.ctx, { ...ACT, region: 'us-east-1' }, session(s, APPROVE));
    assert.match(outside.text, /outside the profile's limits/);
    const destructive = await tool('pf_aws_act').run(s.ctx, { service: 'ec2', operation: 'terminate-instances', params: { 'instance-ids': 'i-0abc12345678' }, reason: 'x' }, session(s, APPROVE));
    assert.match(destructive.text, /not a fix action pf allows/);

    const approve = session(s, APPROVE);
    const ran = await tool('pf_aws_act').run(s.ctx, ACT, approve);
    assert.equal(ran.ok, true, ran.text);
    assert.match(ran.text, /ran after the user approved it/);
    assert.match(ran.text, /"serviceName": "api"/);
    assert.match(fs.readFileSync(s.log, 'utf8'), /ecs update-service --cluster web --service api --force-new-deployment --output json --profile acme-ro --region eu-west-1/);
    const names = s.events.map((e) => e.event);
    assert.ok(names.includes('aws-action-request') && names.includes('aws-action-decision') && names.includes('aws-action'));
    assert.ok(s.events.some((e) => e.event === 'aws-action-refused'));
    // each call asks again: the earlier approval does not carry over
    const again = session(s, { action: 'decline' });
    await tool('pf_aws_act').run(s.ctx, ACT, again);
    assert.equal(again.asked.length, 1);
  } finally {
    s.restore();
  }

  const repoNarrowed = setup({ actions: ['ecs update-service'], repo: { agent: { aws: { actions: [] } } } });
  try {
    assert.match((await tool('pf_aws_act').run(repoNarrowed.ctx, ACT, session(repoNarrowed, APPROVE))).text, /not enabled for this profile/);
  } finally {
    repoNarrowed.restore();
  }

  const unpinned = setup({ actions: ['ecs update-service'] });
  try {
    fs.writeFileSync(`${process.env.PF_HOME}/config.json`, json({ profiles: { acme: { aws: { profile: 'acme-ro', region: 'eu-west-1' }, agent: { aws: { actions: ['ecs update-service'] } } } } }));
    const ctx = buildContext(unpinned.repo);
    assert.match((await tool('pf_aws_act').run(ctx, ACT, session(unpinned, APPROVE))).text, /need a pinned account/);
  } finally {
    unpinned.restore();
  }

  const wrong = setup({ actions: ['ecs update-service'], account: '999999999999' });
  try {
    const sess = session(wrong, APPROVE);
    const r = await tool('pf_aws_act').run(wrong.ctx, ACT, sess);
    assert.match(r.text, /not the pinned account 123456789012/);
    assert.equal(sess.asked.length, 0, 'the user is not asked about the wrong account');
    assert.ok(wrong.events.some((e) => e.event === 'aws-account-mismatch'));
  } finally {
    wrong.restore();
  }
});
