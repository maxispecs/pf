import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeProfile, validateProfileFlags } from '../src/commands/profile.js';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

function pf(cwd: string, env: Record<string, string>, ...args: string[]) {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', ...env };
  delete e.FORCE_COLOR;
  delete e.PF_PROFILE;
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('profile flags are checked before anything is saved', () => {
  assert.equal(validateProfileFlags({ awsProfile: 'acme-ro', account: '123456789012', region: 'eu-west-1', scopes: ['ec2', 'logs'], regions: ['us-east-1'], maxTtl: '30' }), null);
  assert.match(validateProfileFlags({ account: '123' })!, /12 digits/);
  assert.match(validateProfileFlags({ region: 'europe' })!, /not a region/);
  assert.match(validateProfileFlags({ scopes: ['ec2', 'iam-admin'] })!, /unknown scope "iam-admin"/);
  assert.match(validateProfileFlags({ maxTtl: '9999' })!, /--max-ttl/);
  assert.match(validateProfileFlags({ awsProfile: 'bad name' })!, /not an AWS profile name/);
});

test('mergeProfile edits fields in place and an empty value clears one', () => {
  const current = { aws: { profile: 'a', account: '123456789012', region: 'eu-west-1' }, agent: { aws: { scopes: ['ec2'] } } };
  assert.deepEqual(mergeProfile(current, { region: '', maxTtl: '15' }), { aws: { profile: 'a', account: '123456789012' }, agent: { aws: { scopes: ['ec2'], maxTtlMinutes: 15 } } });
  assert.deepEqual(mergeProfile({}, { awsProfile: 'b' }), { aws: { profile: 'b' } });
});

test('pf profile: add, list, use, show with repo narrowing, remove', () => {
  const home = mkRepo({});
  const env = { PF_HOME: home };
  const cwd = mkRepo({ '.git/HEAD': '', 'pulpfixer.json': json({ profile: 'acme', agent: { aws: { scopes: ['ec2'] } } }) });

  const empty = pf(cwd, env, 'profile');
  assert.equal(empty.code, 0);
  assert.match(empty.out, /No profiles yet/);

  const noTty = pf(cwd, env, 'profile', 'add', 'acme');
  assert.equal(noTty.code, 2);
  assert.match(noTty.err, /pass the values as flags/);

  const dry = pf(cwd, env, 'profile', 'add', 'acme', '--aws-profile', 'acme-ro', '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.err, /would save profile acme/);
  assert.ok(!fs.existsSync(path.join(home, 'config.json')));

  const add = pf(cwd, env, 'profile', 'add', 'acme', '--aws-profile', 'acme-ro', '--account', '123456789012', '--region', 'eu-west-1', '--scopes', 'identity,ec2,ecs');
  assert.equal(add.code, 0, add.err);
  const bad = pf(cwd, env, 'profile', 'add', 'other', '--aws-profile', 'x', '--scopes', 'root');
  assert.equal(bad.code, 2);

  const list = pf(cwd, env, 'profile');
  assert.match(list.out, /acme-ro/);
  assert.match(list.out, /here: acme \(from pulpfixer\.json\)/);

  const show = pf(cwd, env, 'profile', 'show');
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /scopes identity, ec2; regions eu-west-1; at most 60 min/);
  assert.match(show.out, /narrowed by this repo's pulpfixer\.json/);

  assert.equal(pf(cwd, env, 'profile', 'use', 'nope').code, 2);
  assert.equal(pf(cwd, env, 'profile', 'use', 'acme').code, 0);
  assert.equal((JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as { defaultProfile: string }).defaultProfile, 'acme');

  const check = pf(cwd, env, 'profile', 'check', '--dry-run');
  assert.match(check.err, /would run aws sts get-caller-identity --output json --profile acme-ro --region eu-west-1/);

  const unknownAgent = pf(cwd, env, 'agent', '--profile', 'ghost', '--dry-run');
  assert.equal(unknownAgent.code, 2);
  assert.match(unknownAgent.err, /no profile named "ghost"/);

  assert.equal(pf(cwd, env, 'profile', 'remove', 'acme').code, 0);
  assert.match(pf(cwd, env, 'profile').out, /No profiles yet/);
});

test('pf aws: grants list is empty, revoke needs a target', () => {
  const env = { PF_HOME: mkRepo({}) };
  const cwd = mkRepo({});
  assert.match(pf(cwd, env, 'aws').out, /No live AWS grants/);
  assert.equal(pf(cwd, env, 'aws', 'revoke').code, 2);
  assert.equal(pf(cwd, env, 'aws', 'revoke', '--all').code, 0);
});

test('--actions: only known fix actions are accepted, merged into the profile, and an empty value clears them', () => {
  assert.equal(validateProfileFlags({ actions: ['ecs update-service', 'ecs stop-task'] }), null);
  assert.match(validateProfileFlags({ actions: ['ec2 terminate-instances'] })!, /unknown action "ec2 terminate-instances"/);
  assert.deepEqual(mergeProfile({ aws: { profile: 'a' } }, { actions: ['ecs stop-task'] }), { aws: { profile: 'a' }, agent: { aws: { actions: ['ecs stop-task'] } } });
  assert.deepEqual(mergeProfile({ aws: { profile: 'a' }, agent: { aws: { scopes: ['ec2'], actions: ['ecs stop-task'] } } }, { actions: [] }), { aws: { profile: 'a' }, agent: { aws: { scopes: ['ec2'] } } });

  const home = mkRepo({});
  const env = { PF_HOME: home };
  const cwd = mkRepo({ '.git/HEAD': '', 'pulpfixer.json': json({ profile: 'acme' }) });
  assert.equal(pf(cwd, env, 'profile', 'add', 'acme', '--aws-profile', 'acme-ro', '--actions', 'ecs update-service').code, 0);
  assert.match(pf(cwd, env, 'profile', 'show').out, /fix actions \(each approved by the user\): ecs update-service/);
  assert.equal(pf(cwd, env, 'profile', 'add', 'acme', '--actions', 'rds delete-db-instance').code, 2);
});
