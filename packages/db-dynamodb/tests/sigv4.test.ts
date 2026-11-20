import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amzDate, sign, signingKey } from '../src/sigv4.js';

// AWS's published SigV4 test-suite case "get-vanilla".
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const NOW = new Date('2015-08-30T12:36:00Z');

test('amzDate is the compact ISO form', () => {
  assert.equal(amzDate(NOW), '20150830T123600Z');
});

test('matches the AWS get-vanilla test vector', () => {
  const h = sign({ method: 'GET', host: 'example.amazonaws.com', headers: {}, body: '', region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, now: NOW });
  assert.equal(
    h.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
  assert.equal(h['x-amz-date'], '20150830T123600Z');
});

test('a session token is sent and signed', () => {
  const h = sign({ method: 'POST', host: 'h', headers: { 'Content-Type': 'application/x-amz-json-1.0' }, body: '{}', region: 'eu-west-1', service: 'dynamodb', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, sessionToken: 'TOKEN', now: NOW });
  assert.equal(h['x-amz-security-token'], 'TOKEN');
  assert.match(h.authorization!, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/);
});

test('the signature depends on the body, the region and the secret', () => {
  const base = { method: 'POST', host: 'h', headers: {}, body: '{}', region: 'eu-west-1', service: 'dynamodb', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, now: NOW };
  const sig = (o: object) => sign({ ...base, ...o }).authorization;
  assert.notEqual(sig({}), sig({ body: '{"a":1}' }));
  assert.notEqual(sig({}), sig({ region: 'us-east-1' }));
  assert.notEqual(sig({}), sig({ secretAccessKey: SECRET + 'x' }));
  assert.equal(sig({}), sig({}));
});

test('signingKey is 32 bytes and differs per day', () => {
  assert.equal(signingKey(SECRET, '20150830', 'us-east-1', 'iam').length, 32);
  assert.notDeepEqual(signingKey(SECRET, '20150830', 'us-east-1', 'iam'), signingKey(SECRET, '20150831', 'us-east-1', 'iam'));
});
