import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { loadRepoConfig, loadUserConfig, userConfigPath, type RepoConfig, type UserConfig } from '../src/config.js';
import { linkRepoProfile, narrowLimits, removeProfile, resolveProfile, saveProfile, setDefaultProfile } from '../src/profiles.js';
import { json, mkRepo } from './helpers.js';

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
  }
}

test('pf.json: profile name and agent.aws limits are parsed, junk is dropped', () => {
  const dir = mkRepo({ 'pf.json': json({ profile: ' acme ', agent: { aws: { scopes: ['ec2', 3, ''], regions: 'eu-west-1', maxTtlMinutes: -5 } } }) });
  const cfg = loadRepoConfig(dir);
  assert.equal(cfg.profile, 'acme');
  assert.deepEqual(cfg.agent, { aws: { scopes: ['ec2'] } });
  assert.deepEqual(loadRepoConfig(mkRepo({ 'pf.json': json({ commands: {} }) })), { commands: {} });
});

test('user config: profiles are parsed and other keys are kept', () => {
  const home = mkRepo({
    'config.json': json({
      agent: 'claude',
      defaultProfile: 'acme',
      profiles: { acme: { aws: { profile: 'acme-ro', account: '123456789012', region: 'eu-west-1', extra: 1 }, agent: { aws: { scopes: ['ec2'], maxTtlMinutes: 30 } } }, bad: 'x' },
    }),
  });
  const user = withHome(home, () => loadUserConfig());
  assert.equal(user.agent, 'claude');
  assert.equal(user.defaultProfile, 'acme');
  assert.deepEqual(user.profiles!.acme, { aws: { profile: 'acme-ro', account: '123456789012', region: 'eu-west-1' }, agent: { aws: { scopes: ['ec2'], maxTtlMinutes: 30 } } });
  assert.deepEqual(user.profiles!.bad, {});
});

test('profile resolution: flag, then PF_PROFILE, then pf.json, then the default', () => {
  const user: UserConfig = { profiles: { a: {}, b: {}, c: {} }, defaultProfile: 'c' };
  const config: RepoConfig = { commands: {}, profile: 'b' };
  assert.deepEqual(resolveProfile({ config, user }, { flag: 'a', env: 'b' }), { name: 'a', source: 'flag', config: {} });
  assert.equal(resolveProfile({ config, user }, { env: 'a' })!.source, 'env');
  assert.equal(resolveProfile({ config, user }, { env: undefined })!.name, 'b');
  assert.equal(resolveProfile({ config: { commands: {} }, user }, { env: '' })!.source, 'default');
  assert.equal(resolveProfile({ config: { commands: {} }, user: {} }, { env: undefined }), null);
  const unknown = resolveProfile({ config: { commands: {}, profile: 'zzz' }, user }, { env: undefined })!;
  assert.equal(unknown.config, null);
});

test('a repo can only narrow the limits, never widen them', () => {
  const caps = { scopes: ['identity', 'ec2', 'ecs'], regions: ['eu-west-1'], maxTtlMinutes: 60 };
  assert.deepEqual(narrowLimits(caps, undefined), caps);
  assert.deepEqual(narrowLimits(caps, { scopes: ['ec2', 'logs'], regions: ['eu-west-1', 'us-east-1'], maxTtlMinutes: 600 }), { scopes: ['ec2'], regions: ['eu-west-1'], maxTtlMinutes: 60 });
  assert.deepEqual(narrowLimits({ ...caps, regions: null }, { regions: ['us-east-1'], maxTtlMinutes: 15 }), { scopes: caps.scopes, regions: ['us-east-1'], maxTtlMinutes: 15 });
});

test('actions: parsed from both layers, off unless the user allows them, and a repo only removes', () => {
  const dir = mkRepo({ 'pf.json': json({ agent: { aws: { actions: ['ecs update-service', 7, ''] } } }) });
  assert.deepEqual(loadRepoConfig(dir).agent, { aws: { actions: ['ecs update-service'] } });
  const home = mkRepo({ 'config.json': json({ profiles: { a: { aws: { profile: 'p' }, agent: { aws: { actions: ['ecs stop-task', 'ec2 reboot-instances'] } } } } }) });
  assert.deepEqual(withHome(home, () => loadUserConfig()).profiles!.a!.agent, { aws: { actions: ['ecs stop-task', 'ec2 reboot-instances'] } });

  const caps = { scopes: ['identity'], regions: null, maxTtlMinutes: 60, actions: ['ecs stop-task', 'ec2 reboot-instances'] };
  assert.deepEqual(narrowLimits(caps, { actions: ['ec2 reboot-instances', 'rds reboot-db-instance'] }).actions, ['ec2 reboot-instances']);
  assert.deepEqual(narrowLimits(caps, { actions: [] }).actions, []);
  assert.deepEqual(narrowLimits(caps, { scopes: ['identity'] }).actions, caps.actions);
  const none = { scopes: ['identity'], regions: null, maxTtlMinutes: 60 };
  assert.equal(narrowLimits(none, { actions: ['ecs stop-task'] }).actions, undefined, 'a repo cannot add an action');
});

test('linkRepoProfile sets "profile" in pf.json, keeps other keys, and never overwrites broken JSON', () => {
  const dir = mkRepo({ 'pf.json': json({ name: 'api', commands: { x: 'y' } }) });
  assert.equal(linkRepoProfile(dir, 'acme'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/pf.json`, 'utf8')), { name: 'api', commands: { x: 'y' }, profile: 'acme' });
  const fresh = mkRepo();
  assert.equal(linkRepoProfile(fresh, 'acme'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${fresh}/pf.json`, 'utf8')), { profile: 'acme' });
  const broken = mkRepo({ 'pf.json': '{ nope' });
  assert.equal(linkRepoProfile(broken, 'acme'), false);
  assert.equal(fs.readFileSync(`${broken}/pf.json`, 'utf8'), '{ nope');
});

test('saveProfile, setDefaultProfile and removeProfile keep the rest of the config', () => {
  const home = mkRepo({ 'config.json': json({ agent: 'codex', plugins: { aws: { exchange: { bucket: 'b' } } } }) });
  withHome(home, () => {
    assert.equal(saveProfile('acme', { aws: { profile: 'acme-ro' } }), true);
    assert.equal(setDefaultProfile('acme'), true);
    let written = JSON.parse(fs.readFileSync(userConfigPath(), 'utf8')) as Record<string, unknown>;
    assert.equal(written.agent, 'codex');
    assert.deepEqual(written.profiles, { acme: { aws: { profile: 'acme-ro' } } });
    assert.equal(written.defaultProfile, 'acme');
    assert.equal(removeProfile('acme'), true);
    written = JSON.parse(fs.readFileSync(userConfigPath(), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(written.profiles, {});
    assert.equal(written.defaultProfile, undefined);
    assert.deepEqual(written.plugins, { aws: { exchange: { bucket: 'b' } } });
  });
});
