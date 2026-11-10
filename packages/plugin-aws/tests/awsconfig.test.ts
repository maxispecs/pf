import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAwsProfiles, matchProfiles, parseAwsConfig, suggestProfileName } from '../src/awsconfig.js';
import { mkRepo } from './helpers.js';

const CONFIG = `
[default]
region = us-east-1

[sso-session corp]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1

[profile acme-ro]
sso_session = corp
sso_account_id = 123456789012
sso_role_name = ReadOnly
region = eu-west-1

# comment
[profile acme-admin]
role_arn = arn:aws:iam::123456789012:role/admin
source_profile = default

[profile side]
aws_access_key_id = AKIAABCDEFGHIJKLMNOP
`;

test('parseAwsConfig keeps names, account, region and kind, and nothing else', () => {
  const p = parseAwsConfig(CONFIG);
  assert.deepEqual(p.map((x) => x.name), ['default', 'acme-ro', 'acme-admin', 'side']);
  assert.deepEqual(p[1], { name: 'acme-ro', kind: 'sso', account: '123456789012', region: 'eu-west-1' });
  assert.deepEqual(p[2], { name: 'acme-admin', kind: 'role', account: '123456789012' });
  assert.deepEqual(p[3], { name: 'side', kind: 'other' });
  assert.doesNotMatch(JSON.stringify(p), /AKIA|awsapps/);
});

test('listAwsProfiles reads AWS_CONFIG_FILE-style paths and tolerates a missing file', () => {
  const dir = mkRepo({ config: CONFIG });
  assert.equal(listAwsProfiles(`${dir}/config`).length, 4);
  assert.deepEqual(listAwsProfiles(`${dir}/nope`), []);
});

test('matchProfiles ranks account matches first, registered before unregistered', () => {
  const aws = parseAwsConfig(CONFIG);
  const registered = { acme: { aws: { profile: 'acme-ro', account: '123456789012' } }, other: { aws: { profile: 'elsewhere', account: '999999999999' } }, empty: {} };
  const ranked = matchProfiles({ accounts: ['123456789012'], regions: ['eu-west-1'], repoName: 'acme-api' }, aws, registered);
  assert.equal(ranked[0]!.kind, 'registered');
  assert.equal(ranked[0]!.name, 'acme');
  assert.ok(ranked[0]!.score >= 6);
  assert.match(ranked[0]!.reasons.join(), /account 123456789012 appears/);
  assert.equal(ranked[1]!.name, 'acme-admin', 'an unregistered AWS profile in the same account follows');
  assert.equal(ranked[1]!.kind, 'aws');
  assert.ok(!ranked.some((c) => c.kind === 'aws' && c.name === 'acme-ro'), 'shown once, as the registered profile');
  assert.ok(!ranked.some((c) => c.name === 'empty'), 'a pf profile with no AWS profile is not linkable');
});

test('suggestProfileName gives a valid, unused name', () => {
  assert.equal(suggestProfileName('acme-ro', []), 'acme-ro');
  assert.equal(suggestProfileName('acme-ro', ['acme-ro']), 'acme-ro-2');
  assert.equal(suggestProfileName('weird name@corp', []), 'weird-name-corp');
  assert.equal(suggestProfileName('@@@', []), 'profile');
});
