import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAction, checkOperation, DEFAULT_SCOPES, limitsFor, paramArgv, redactJson, redactText } from '../src/access.js';
import { activeGrant, liveGrants, revokeGrants, saveGrant, type Grant } from '../src/grants.js';
import { mkRepo } from './helpers.js';

test('operations: allowed by scope, refused with a reason otherwise', () => {
  assert.deepEqual(checkOperation('ecs', 'describe-services', ['identity', 'ecs']), { ok: true, scope: 'ecs' });
  assert.deepEqual(checkOperation('sts', 'get-caller-identity', ['identity']), { ok: true, scope: 'identity' });
  const other = checkOperation('logs', 'filter-log-events', ['identity', 'ec2']);
  assert.ok(!other.ok && /needs the "logs" scope/.test(other.reason));
  const denied = checkOperation('secretsmanager', 'get-secret-value', ['identity', 'ec2', 'logs']);
  assert.ok(!denied.ok && /never allowed: it returns secret values/.test(denied.reason));
  const write = checkOperation('ec2', 'terminate-instances', ['ec2']);
  assert.ok(!write.ok && /not a read-only operation/.test(write.reason));
  assert.equal(checkOperation('ssm', 'get-parameter', ['ssm-metadata']).ok, false);
  assert.equal(checkOperation('s3api', 'get-object', ['s3-metadata']).ok, false);
});

test('limits: logs needs an opt-in, regions default to the profile, the repo only narrows', () => {
  assert.ok(!DEFAULT_SCOPES.includes('logs'));
  const base = limitsFor({ aws: { profile: 'p', region: 'eu-west-1' } }, undefined);
  assert.deepEqual(base.regions, ['eu-west-1']);
  assert.equal(base.maxTtlMinutes, 60);
  assert.ok(!base.scopes.includes('logs'));
  const capped = limitsFor({ aws: { profile: 'p' }, agent: { aws: { scopes: ['identity', 'ec2', 'logs'], maxTtlMinutes: 9999 } } }, { scopes: ['logs', 'rds'] });
  assert.deepEqual(capped.scopes, ['identity', 'logs']);
  assert.equal(capped.maxTtlMinutes, 480);
  assert.equal(capped.regions, null);
  assert.deepEqual(limitsFor({ agent: { aws: { scopes: ['ec2', 'bogus'] } } }, undefined).scopes, ['ec2']);
});

test('params become argv; files, URLs, flag-like values and pf-owned flags are refused', () => {
  assert.deepEqual(paramArgv({ cluster: 'web', services: ['api', 'worker'], 'max-items': 5, 'include-all': true, skip: false }), {
    ok: true,
    argv: ['--cluster', 'web', '--services', 'api', 'worker', '--max-items', '5', '--include-all'],
  });
  assert.deepEqual(paramArgv(undefined), { ok: true, argv: [] });
  assert.equal(paramArgv({ '--query': 'Reservations[].Instances[].InstanceId' }).ok, true);
  for (const bad of [{ profile: 'x' }, { region: 'x' }, { 'endpoint-url': 'x' }, { 'cli-input-json': 'x' }, { 'with-decryption': true }, { filters: 'file:///etc/passwd' }, { filters: 'fileb://k' }, { filters: 'https://x' }, { cluster: '--debug' }, { 'Bad Flag': 'x' }, { cluster: { a: 1 } }]) {
    assert.equal(paramArgv(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(paramArgv(['a']).ok, false);
});

test('redaction: environment values, secret-named fields and secret-looking text', () => {
  const task = {
    taskDefinition: {
      containerDefinitions: [{ name: 'api', image: 'x:1', environment: [{ name: 'DB_HOST', value: 'db.internal' }, { name: 'API_KEY', value: 'abc' }] }],
      tags: [{ key: 'team', value: 'core' }],
    },
    nextToken: 'page-2',
    Parameters: [{ Name: 'db_password', Value: 'hunter2' }, { Name: 'region', Value: 'eu-west-1' }],
    MasterUserPassword: 'pw',
  };
  const out = redactJson(task) as typeof task;
  assert.equal(out.taskDefinition.containerDefinitions[0]!.environment[0]!.value, '[redacted by pf]');
  assert.equal(out.taskDefinition.containerDefinitions[0]!.environment[0]!.name, 'DB_HOST');
  assert.equal(out.taskDefinition.containerDefinitions[0]!.image, 'x:1');
  assert.equal(out.taskDefinition.tags[0]!.value, 'core');
  assert.equal(out.nextToken, 'page-2');
  assert.equal(out.Parameters[0]!.Value, '[redacted by pf]');
  assert.equal(out.Parameters[1]!.Value, 'eu-west-1');
  assert.equal(out.MasterUserPassword, '[redacted by pf]');

  const text = redactText('key AKIAABCDEFGHIJKLMNOP password=hunter2 Authorization: Bearer abcdefghijklmnop token: "xyz123" ok=1');
  assert.doesNotMatch(text, /AKIAABCDEFGHIJKLMNOP|hunter2|abcdefghijklmnop|xyz123/);
  assert.match(text, /ok=1/);
  assert.match(redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'), /^\[redacted by pf\]$/);
});

test('grants: live until they expire or their server is gone, and revocable', () => {
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = mkRepo({});
  try {
    const now = Date.now();
    const grant = (session: string, pid: number, minutes: number): Grant => ({
      session,
      pid,
      profile: 'acme',
      awsProfile: 'acme-ro',
      scopes: ['identity', 'ec2'],
      regions: ['eu-west-1'],
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + minutes * 60_000).toISOString(),
      reason: 'test',
      approvedBy: 'dialog',
    });
    assert.equal(saveGrant(grant('live', process.pid, 10)), true);
    assert.equal(saveGrant(grant('expired', process.pid, -1)), true);
    assert.equal(saveGrant(grant('dead', 2 ** 22 + 12345, 10)), true);
    assert.deepEqual(liveGrants().map((g) => g.session), ['live']);
    assert.ok(activeGrant('live', 'acme'));
    assert.equal(activeGrant('live', 'other'), undefined);
    assert.equal(activeGrant('live', 'acme', now + 11 * 60_000), undefined);
    assert.equal(revokeGrants((g) => g.session === 'live'), 1);
    assert.equal(activeGrant('live', 'acme'), undefined);
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
  }
});

test('lambda and cloudformation reads: scopes exist, template and invoke are refused, env values are redacted', () => {
  assert.deepEqual(checkOperation('lambda', 'get-function-configuration', ['identity', 'lambda-metadata']), { ok: true, scope: 'lambda-metadata' });
  assert.deepEqual(checkOperation('cloudformation', 'describe-stack-events', ['cloudformation']), { ok: true, scope: 'cloudformation' });
  assert.match((checkOperation('cloudformation', 'get-template', ['cloudformation']) as { reason: string }).reason, /never allowed: it returns templates/);
  assert.match((checkOperation('lambda', 'invoke', ['lambda-metadata']) as { reason: string }).reason, /never allowed/);
  assert.match((checkOperation('lambda', 'get-function', ['lambda-metadata']) as { reason: string }).reason, /never allowed/);

  const fn = redactJson({ FunctionName: 'f', Environment: { Variables: { DB_HOST: 'db', STRIPE: 'sk_live' } } }) as { Environment: { Variables: Record<string, string> } };
  assert.deepEqual(fn.Environment.Variables, { DB_HOST: '[redacted by pf]', STRIPE: '[redacted by pf]' });
  const stack = redactJson({ Stacks: [{ Parameters: [{ ParameterKey: 'DbPassword', ParameterValue: 'hunter2' }, { ParameterKey: 'Stage', ParameterValue: 'prod' }] }] }) as { Stacks: { Parameters: { ParameterValue: string }[] }[] };
  assert.equal(stack.Stacks[0]!.Parameters[0]!.ParameterValue, '[redacted by pf]');
  assert.equal(stack.Stacks[0]!.Parameters[1]!.ParameterValue, 'prod');
});

test('fix actions: off by default, only the listed flags and values, destructive calls refused', () => {
  const on = ['ecs update-service', 'ecs stop-task', 'ec2 reboot-instances', 'autoscaling set-desired-capacity'];
  assert.deepEqual(limitsFor({ aws: { profile: 'p' } }, undefined).actions, []);
  assert.deepEqual(limitsFor({ agent: { aws: { actions: ['ecs stop-task', 'ec2 terminate-instances'] } } }, undefined).actions, ['ecs stop-task']);
  assert.deepEqual(limitsFor({ agent: { aws: { actions: on } } }, { actions: ['ecs stop-task'] }).actions, ['ecs stop-task']);

  const ok = checkAction('ecs', 'update-service', { cluster: 'web', service: 'api', 'force-new-deployment': true }, on);
  assert.deepEqual(ok.ok && ok.argv, ['--cluster', 'web', '--service', 'api', '--force-new-deployment']);
  assert.equal(checkAction('ecs', 'update-service', { cluster: 'web', service: 'api', 'desired-count': 3 }, on).ok, true);
  assert.equal(checkAction('ec2', 'reboot-instances', { 'instance-ids': ['i-0abc12345678'] }, on).ok, true);

  const reason = (r: ReturnType<typeof checkAction>): string => (r.ok ? 'ok' : r.reason);
  assert.match(reason(checkAction('ecs', 'update-service', { cluster: 'web', service: 'api', 'force-new-deployment': true }, [])), /not enabled for this profile/);
  assert.match(reason(checkAction('ec2', 'terminate-instances', { 'instance-ids': 'i-0abc12345678' }, on)), /not a fix action pf allows/);
  assert.match(reason(checkAction('ecs', 'update-service', { cluster: 'web', service: 'api' }, on)), /at least one of/);
  assert.match(reason(checkAction('ecs', 'update-service', { cluster: 'web' , 'force-new-deployment': true }, on)), /needs --service/);
  assert.match(reason(checkAction('ecs', 'update-service', { cluster: 'web', service: 'api', 'desired-count': 'lots' }, on)), /not an accepted value/);
  assert.match(reason(checkAction('ecs', 'update-service', { cluster: 'web', service: 'api', 'force-new-deployment': true, 'deployment-configuration': 'x' }, on)), /not accepted by aws ecs update-service/);
  assert.match(reason(checkAction('ecs', 'stop-task', { cluster: 'web', task: 'file:///etc/passwd' }, on)), /load a file or URL/);
  assert.match(reason(checkAction('ec2', 'reboot-instances', { 'instance-ids': 'web-1' }, on)), /not an accepted value/);
  assert.match(reason(checkAction('ecs', 'update-service', { cluster: 'web', service: 'api', profile: 'x' }, on)), /not accepted/);
  assert.match(reason(checkAction('ecs', 'stop-task', ['x'], on)), /params must be an object/);
});
