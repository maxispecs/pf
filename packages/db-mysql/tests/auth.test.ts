import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import { AuthFlow, cachingSha2Password, nativePassword } from '../src/auth.js';
import { ed25519PublicKey, ed25519Sign } from '../src/ed25519.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

test('ed25519 with a 32-byte secret is standard Ed25519 with that seed', () => {
  for (let i = 0; i < 3; i++) {
    const seed = randomBytes(32);
    const message = randomBytes(32);
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
    assert.deepEqual(ed25519Sign(message, seed), sign(null, message, key));
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    assert.deepEqual(ed25519PublicKey(seed), spki.subarray(SPKI_ED25519.length));
  }
});

test('ed25519 with a password of any length verifies against its public key', () => {
  for (const password of ['', 'pw', 'a much longer password than thirty-two bytes, with ünïcode']) {
    const secret = Buffer.from(password);
    const message = randomBytes(32);
    const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519, ed25519PublicKey(secret)]), format: 'der', type: 'spki' });
    assert.ok(verify(null, message, pub, ed25519Sign(message, secret)), password);
  }
});

test('an empty password sends an empty scramble', () => {
  assert.equal(nativePassword('', randomBytes(20)).length, 0);
  assert.equal(cachingSha2Password('', randomBytes(20)).length, 0);
  assert.equal(nativePassword('x', randomBytes(20)).length, 20);
  assert.equal(cachingSha2Password('x', randomBytes(20)).length, 32);
});

test('AuthFlow: the first plugin, caching_sha2 full auth on TLS, unknown plugins', () => {
  const nonce = randomBytes(20);
  assert.equal(new AuthFlow('pw', false).start('client_ed25519', nonce).plugin, 'mysql_native_password', 'starts with native and lets the server switch');
  const tls = new AuthFlow('pw', true);
  assert.equal(tls.start('caching_sha2_password', nonce).plugin, 'caching_sha2_password');
  assert.equal(tls.more(Buffer.from([0x03])), null, 'fast auth: nothing to send');
  assert.deepEqual(tls.more(Buffer.from([0x04])), Buffer.from('pw\0'), 'on TLS the password goes as is');
  const plain = new AuthFlow('pw', false);
  plain.start('caching_sha2_password', nonce);
  assert.deepEqual(plain.more(Buffer.from([0x04])), Buffer.from([0x02]), 'without TLS it asks for the RSA key');
  assert.throws(() => new AuthFlow('pw', false).switchTo('sha256_password', nonce), /"sha256_password" authentication plugin/);
  assert.throws(() => new AuthFlow('pw', false).switchTo('client_ed25519', Buffer.alloc(8)), /short nonce/);
});
