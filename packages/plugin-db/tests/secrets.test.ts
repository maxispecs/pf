import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DbError } from '../src/errors.js';
import { describeRef, isSecretRef, keychainAccount, parseSecretRef, resolveSecret, setKeychain } from '../src/secrets.js';
import { capture, memoryKeychain } from './helpers.js';

test('secret sources: keychain, env:NAME, prompt', () => {
  assert.deepEqual(parseSecretRef('keychain'), { from: 'keychain' });
  assert.deepEqual(parseSecretRef('prompt'), { from: 'prompt' });
  assert.deepEqual(parseSecretRef('env:DB_PASSWORD'), { from: 'env', name: 'DB_PASSWORD' });
  assert.match(parseSecretRef('env:bad name') as string, /not an environment variable/);
  assert.match(parseSecretRef('plain:secret') as string, /not a secret source/);
  assert.equal(describeRef({ from: 'env', name: 'X' }), 'env:X');
  assert.ok(isSecretRef({ from: 'keychain' }));
  assert.ok(!isSecretRef({ from: 'file', path: '/x' }));
  assert.ok(!isSecretRef({ from: 'env', name: 'a b' }));
  assert.equal(keychainAccount('billing', 'password'), 'billing.password');
});

test('resolveSecret reads the environment and the keychain, and says how to fix what is missing', async () => {
  process.env.PF_DB_TEST_SECRET = 's3cret';
  assert.equal(await resolveSecret('c', 'password', { from: 'env', name: 'PF_DB_TEST_SECRET' }), 's3cret');
  delete process.env.PF_DB_TEST_SECRET;
  await assert.rejects(resolveSecret('c', 'password', { from: 'env', name: 'PF_DB_TEST_SECRET' }), (e: unknown) => e instanceof DbError && /PF_DB_TEST_SECRET/.test(e.message));

  const k = memoryKeychain();
  setKeychain(k);
  k.items.set('c.password', 'kc-secret');
  assert.equal(await resolveSecret('c', 'password', { from: 'keychain' }), 'kc-secret');
  await assert.rejects(resolveSecret('c', 'token', { from: 'keychain' }), /no token in test keychain/);
  setKeychain(null);
  await assert.rejects(resolveSecret('c', 'password', { from: 'keychain' }), /not available/);
});

test('prompt secrets need a terminal', async () => {
  const r = await capture(async () => {
    await assert.rejects(resolveSecret('c', 'password', { from: 'prompt' }), /no terminal/);
    return 0;
  });
  assert.equal(r.code, 0);
});
