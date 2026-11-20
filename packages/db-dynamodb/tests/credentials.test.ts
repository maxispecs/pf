import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cachedCredentials, checkProfileName, CredentialsError, parseExported, parseIni, resolveCredentials } from '../src/credentials.js';

const tmp = (content: string): string => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ddb-')), 'credentials');
  fs.writeFileSync(f, content);
  return f;
};
const NO_FILE = path.join(os.tmpdir(), 'pf-ddb-does-not-exist');
const noAws = async (): Promise<string> => {
  throw new CredentialsError('the aws CLI is not installed (needed for SSO and assume-role profiles)');
};

test('parseIni reads sections, comments and spacing', () => {
  assert.deepEqual(parseIni('# c\n[default]\naws_access_key_id = A\n; x\n[p2]\nKey=V\n'), { default: { aws_access_key_id: 'A' }, p2: { key: 'V' } });
});

test('keys given to the connection win', async () => {
  const c = await resolveCredentials({ keys: { accessKeyId: 'AKIAEXAMPLE1', secretAccessKey: 's' }, env: { AWS_ACCESS_KEY_ID: 'ENVKEYID123', AWS_SECRET_ACCESS_KEY: 'e' } });
  assert.equal(c.accessKeyId, 'AKIAEXAMPLE1');
  await assert.rejects(() => resolveCredentials({ keys: { accessKeyId: 'bad id!', secretAccessKey: 's' } }), /access key id/);
});

test('environment variables are used when no profile is named', async () => {
  const c = await resolveCredentials({ env: { AWS_ACCESS_KEY_ID: 'ENVKEYID123', AWS_SECRET_ACCESS_KEY: 'e', AWS_SESSION_TOKEN: 't' }, credentialsFile: NO_FILE, runAws: noAws });
  assert.deepEqual(c, { accessKeyId: 'ENVKEYID123', secretAccessKey: 'e', sessionToken: 't' });
});

test('a named profile ignores the environment and reads static keys from the file', async () => {
  const file = tmp('[default]\naws_access_key_id = DEFKEYID123\naws_secret_access_key = d\n[acme]\naws_access_key_id = ACMEKEYID12\naws_secret_access_key = a\naws_session_token = tok\n');
  const env = { AWS_ACCESS_KEY_ID: 'ENVKEYID123', AWS_SECRET_ACCESS_KEY: 'e' };
  assert.deepEqual(await resolveCredentials({ profile: 'acme', env, credentialsFile: file, runAws: noAws }), { accessKeyId: 'ACMEKEYID12', secretAccessKey: 'a', sessionToken: 'tok' });
  assert.equal((await resolveCredentials({ env: {}, credentialsFile: file, runAws: noAws })).accessKeyId, 'DEFKEYID123');
});

test('a profile without static keys goes to the aws CLI, with an argv that cannot be an option', async () => {
  let args: string[] = [];
  const out = JSON.stringify({ Version: 1, AccessKeyId: 'SSOKEYID1234', SecretAccessKey: 's', SessionToken: 'st', Expiration: '2030-01-01T00:00:00Z' });
  const c = await resolveCredentials({ profile: 'sso-acme', env: {}, credentialsFile: NO_FILE, runAws: async (a) => ((args = a), out) });
  assert.deepEqual(args, ['configure', 'export-credentials', '--format', 'process', '--profile', 'sso-acme']);
  assert.equal(c.sessionToken, 'st');
  assert.equal(c.expiration?.toISOString(), '2030-01-01T00:00:00.000Z');
  await assert.rejects(() => resolveCredentials({ profile: '--debug', env: {}, credentialsFile: NO_FILE, runAws: noAws }), /not a valid AWS profile/);
});

test('with nothing configured the error says what to do', async () => {
  await assert.rejects(() => resolveCredentials({ env: {}, credentialsFile: NO_FILE, runAws: noAws }), /set AWS_ACCESS_KEY_ID/);
  await assert.rejects(() => resolveCredentials({ profile: 'x', env: {}, credentialsFile: NO_FILE, runAws: noAws }), /aws CLI is not installed/);
});

test('parseExported checks what the CLI returned', () => {
  assert.throws(() => parseExported('nope'), /JSON/);
  assert.throws(() => parseExported('{}'), /no access key/);
  assert.equal(parseExported('{"AccessKeyId":"A","SecretAccessKey":"S"}').sessionToken, undefined);
});

test('checkProfileName', () => {
  assert.equal(checkProfileName('acme.prod-1'), 'acme.prod-1');
  for (const bad of ['', '-x', 'a b', 'a;b', '$(id)']) assert.throws(() => checkProfileName(bad), CredentialsError);
});

test('cachedCredentials resolves once, refreshes near expiry and after invalidate', async () => {
  let n = 0;
  let clock = Date.parse('2030-01-01T00:00:00Z');
  const run = async () => JSON.stringify({ AccessKeyId: `KEY${++n}XXXXXXXX`, SecretAccessKey: 's', Expiration: '2030-01-01T01:00:00Z' });
  const cache = cachedCredentials({ profile: 'p', env: {}, credentialsFile: NO_FILE, runAws: run }, () => clock);
  assert.equal((await cache.get()).accessKeyId, 'KEY1XXXXXXXX');
  assert.equal((await cache.get()).accessKeyId, 'KEY1XXXXXXXX');
  clock += 30 * 60_000;
  assert.equal((await cache.get()).accessKeyId, 'KEY1XXXXXXXX');
  clock += 29.5 * 60_000; // inside the last minute
  assert.equal((await cache.get()).accessKeyId, 'KEY2XXXXXXXX');
  cache.invalidate();
  assert.equal((await cache.get()).accessKeyId, 'KEY3XXXXXXXX');
});

test('a failed resolve is not cached', async () => {
  let n = 0;
  const run = async () => {
    if (++n === 1) throw new CredentialsError('boom');
    return JSON.stringify({ AccessKeyId: 'KEYIDXXXXXXX', SecretAccessKey: 's' });
  };
  const cache = cachedCredentials({ profile: 'p', env: {}, credentialsFile: NO_FILE, runAws: run });
  await assert.rejects(() => cache.get(), /boom/);
  assert.equal((await cache.get()).accessKeyId, 'KEYIDXXXXXXX');
});
