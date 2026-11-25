import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PutEntry, SendReport } from '@pulpfixer/plugin-aws/api';
import { loadPublishers, publishersPath, putPublisher, readIdentity, removePublisher, validatePublisher, writeIdentity, type Publisher } from '../src/config.js';
import { dispatch, prepareDispatch } from '../src/dispatch.js';
import { buildEvent } from '../src/envelope.js';
import { CriError } from '../src/errors.js';
import { selectPublisher } from '../src/select.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, '..', 'pulpfixer', 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const identity = { domain: 'orders', stack: 'orders-api' };
const def: Publisher = { type: 'eventbridge', bus: 'orders' };
const payments: Publisher = { type: 'eventbridge', prefix: '@payments/', bus: 'payments', region: 'eu-west-1', profile: 'pay', source: 'orders-pay' };
const refunds: Publisher = { type: 'eventbridge', prefix: '@payments/refunds/', bus: 'refunds' };
const audit: Publisher = { type: 'eventbridge', prefix: 'audit/', bus: 'audit' };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cri-'));
}

/** Run `fn` with PF_HOME pointing at a fresh directory. */
function withHome<T>(fn: (home: string) => T): T {
  const home = tmp();
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
  }
}

// ---- selection ----

test('the longest matching prefix wins', () => {
  const all = [def, payments, refunds, audit];
  assert.equal(selectPublisher(all, '@payments/charge'), payments);
  assert.equal(selectPublisher(all, '@payments/refunds/create'), refunds);
  assert.equal(selectPublisher(all, 'audit/log'), audit);
});

test('a route with no matching prefix goes to the default publisher, cross-domain ones included', () => {
  const all = [payments, def];
  assert.equal(selectPublisher(all, 'users/create'), def);
  assert.equal(selectPublisher(all, '@billing/invoice'), def);
});

test('a prefix matches whole segments', () => {
  assert.equal(selectPublisher([audit, def], 'auditor/log'), def);
});

test('no match and no default is an error with a hint', () => {
  assert.throws(() => selectPublisher([payments], 'users/create'), (e: unknown) => e instanceof CriError && /no publisher/.test(e.message) && /publisher add/.test(e.hint ?? ''));
  assert.throws(() => selectPublisher([], '@billing/x'), (e: unknown) => e instanceof CriError && /@billing\//.test(e.hint ?? ''));
});

// ---- envelope ----

test('an event maps onto an EventBridge entry with _meta in the detail', () => {
  const now = new Date('2026-11-24T15:00:00Z');
  const { input, meta } = buildEvent({ route: '@payments/charge', payload: { amount: 10 }, publisher: payments, identity, now, correlationId: 'corr_1', causationId: 'prev-1', topicId: 't1', hash: 'abc' });
  assert.equal(input.detailType, '@payments/charge');
  assert.equal(input.bus, 'payments');
  assert.equal(input.source, 'orders-pay');
  assert.equal(input.time, '2026-11-24T15:00:00.000Z');
  assert.match(meta.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...meta, id: 'x' }, { id: 'x', correlation_id: 'corr_1', causation_id: 'prev-1', hash: 'abc', topic_id: 't1', source_domain: 'orders', source_stack: 'orders-api', version: 1 });
  assert.deepEqual(input.detail, { amount: 10, _meta: meta });
});

test('the source falls back to the stack name and a correlation id is made', () => {
  const { input, meta } = buildEvent({ route: 'users/create', payload: {}, publisher: def, identity });
  assert.equal(input.source, 'orders-api');
  assert.match(meta.correlation_id, /^corr_[0-9a-f]{12}$/);
  assert.equal('causation_id' in meta, false);
});

test('the payload must be an object without _meta', () => {
  const b = (payload: unknown) => () => buildEvent({ route: 'a/b', payload, publisher: def, identity });
  assert.throws(b({ _meta: {} }), /reserved/);
  assert.throws(b([1]), /JSON object/);
  assert.throws(b('x'), /JSON object/);
  assert.doesNotThrow(b(undefined));
  assert.throws(() => buildEvent({ route: 'a/b', payload: {}, publisher: def, identity, correlationId: 'bad id' }), /correlation id/);
});

// ---- config ----

test('publisher validation', () => {
  assert.deepEqual(validatePublisher({ prefix: '@payments/', bus: 'payments', region: 'eu-west-1', profile: 'p', source: 's' }), { type: 'eventbridge', prefix: '@payments/', bus: 'payments', region: 'eu-west-1', profile: 'p', source: 's' });
  assert.throws(() => validatePublisher({ prefix: 'audit', bus: 'a' }), /end with "\/"/);
  assert.throws(() => validatePublisher({ prefix: 'audit/' }), /bus/);
  assert.throws(() => validatePublisher({ bus: 'a', profile: '--evil' }), /profile/);
  assert.throws(() => validatePublisher({ bus: 'bad bus' }), /bus/);
  assert.throws(() => validatePublisher({ bus: 'a', type: 'sqs' }), /unknown type/);
  assert.throws(() => validatePublisher({ bus: 'a', source: 'aws.thing' }), /reserved/);
});

test('publishers are saved with mode 0600, replaced by prefix, and removed', () => {
  withHome(() => {
    assert.deepEqual(loadPublishers(), []);
    assert.equal(putPublisher({ bus: 'orders' }).replaced, false);
    putPublisher({ prefix: '@payments/', bus: 'payments' });
    assert.equal(putPublisher({ bus: 'orders-2' }).replaced, true);
    assert.deepEqual(loadPublishers().map((p) => `${p.prefix ?? 'default'}:${p.bus}`), ['default:orders-2', '@payments/:payments']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(publishersPath()).mode & 0o777, 0o600);
    assert.equal(removePublisher('nope'), undefined);
    assert.equal(removePublisher('@payments/')?.bus, 'payments');
    assert.equal(loadPublishers().length, 1);
  });
});

test('a malformed publishers file is an error and is never replaced', () => {
  withHome(() => {
    fs.mkdirSync(path.dirname(publishersPath()), { recursive: true });
    fs.writeFileSync(publishersPath(), '{not json');
    assert.throws(() => loadPublishers(), /not valid JSON/);
    assert.throws(() => putPublisher({ bus: 'x' }), /not valid JSON/);
    assert.equal(fs.readFileSync(publishersPath(), 'utf8'), '{not json');
    fs.writeFileSync(publishersPath(), JSON.stringify({ version: 1, publishers: [{ bus: 'a' }, { bus: 'b' }] }));
    assert.throws(() => loadPublishers(), /two publishers for "default"/);
  });
});

test('the identity is read from and written to the cri section of pulpfixer.json', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pulpfixer.json'), JSON.stringify({ name: 'x' }));
  assert.deepEqual(readIdentity(dir), {});
  assert.deepEqual(writeIdentity(dir, { domain: 'orders', stack: 'orders-api' }), { ok: true, changed: true });
  assert.deepEqual(readIdentity(dir), identity);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'pulpfixer.json'), 'utf8')).name, 'x');
  const bad = writeIdentity(dir, { domain: 'has space' });
  assert.equal(bad.ok, false);
  assert.deepEqual(readIdentity(null), {});
});

// ---- dispatch ----

const ok = (ids: string[]): SendReport => ({ sent: ids.length, ids, failures: [] });

test('dispatch sends the event through the selected publisher and returns the acknowledgement', async () => {
  const calls: { entries: PutEntry[]; target: { profile?: string; region?: string } }[] = [];
  const r = await dispatch('@payments/charge', { amount: 10 }, {
    identity,
    publishers: [def, payments],
    now: () => new Date('2026-11-24T15:00:00Z'),
    send: async (entries, target) => {
      calls.push({ entries, target });
      return ok(['eb-1']);
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.target, { profile: 'pay', region: 'eu-west-1' });
  const e = calls[0]!.entries[0]!;
  assert.equal(e.EventBusName, 'payments');
  assert.equal(e.Source, 'orders-pay');
  assert.equal(e.DetailType, '@payments/charge');
  const detail = JSON.parse(e.Detail) as { amount: number; _meta: { id: string; source_domain: string; version: number } };
  assert.equal(detail.amount, 10);
  assert.equal(detail._meta.source_domain, 'orders');
  assert.equal(detail._meta.id, r.id);
  assert.equal(r.eventId, 'eb-1');
  assert.equal(r.publisher, '@payments/');
  assert.equal(r.bus, 'payments');
  assert.equal(r.dryRun, false);
});

test('dispatch on a dry run sends nothing', async () => {
  let called = false;
  const r = await dispatch('users/create', { name: 'A' }, { identity, publishers: [def], dryRun: true, send: async () => ((called = true), ok(['x'])) });
  assert.equal(called, false);
  assert.equal(r.dryRun, true);
  assert.equal(r.eventId, undefined);
  assert.equal(r.publisher, 'default');
});

test('dispatch fails with a CriError when a failed entry, a routing problem or no identity', async () => {
  const failed = async (): Promise<SendReport> => ({ sent: 0, ids: [], failures: [{ index: 0, code: 'AccessDenied', message: 'nope' }] });
  await assert.rejects(dispatch('a/b', {}, { identity, publishers: [def], send: failed }), (e: unknown) => e instanceof CriError && /was not sent/.test(e.message) && /AccessDenied/.test(e.message));
  await assert.rejects(dispatch('a/b', {}, { identity, publishers: [audit], send: async () => ok(['x']) }), /no publisher/);
  await assert.rejects(dispatch('a/b', { _meta: 1 }, { identity, publishers: [def] }), /reserved/);
  await assert.rejects(dispatch('a b', {}, { identity, publishers: [def] }), /whitespace/);
  const empty = tmp();
  await assert.rejects(dispatch('a/b', {}, { publishers: [def], cwd: empty, send: async () => ok(['x']) }), (e: unknown) => e instanceof CriError && /domain and stack/.test(e.message) && /pf cri identity/.test(e.hint ?? ''));
});

test('prepareDispatch reads the identity of the repo around cwd', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pulpfixer.json'), JSON.stringify({ cri: identity }));
  const p = prepareDispatch('users/create', {}, { publishers: [def], cwd: dir });
  assert.equal(p.meta.source_stack, 'orders-api');
  assert.equal(p.source, 'orders-api');
});

// ---- command ----

function pf(args: string[], opts: { home: string; cwd: string; input?: string }) {
  return spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input ?? '',
    env: { ...process.env, PF_HOME: opts.home, NO_COLOR: '1', PF_NO_MASCOT: '1', PF_NO_TRAVOLTA: '1' },
  });
}

test('pf cri: add a publisher, set the identity, check a route, send with --dry-run', () => {
  const home = tmp();
  const repo = tmp();
  fs.writeFileSync(path.join(repo, 'pulpfixer.json'), '{}\n');
  const run = (args: string[], input?: string) => pf(args, { home, cwd: repo, ...(input !== undefined ? { input } : {}) });

  assert.equal(run(['cri', 'publisher', 'add', '--bus', 'orders']).status, 0);
  assert.equal(run(['cri', 'publisher', 'add', '@payments/', '--bus', 'payments', '--region', 'eu-west-1', '--profile', 'pay']).status, 0);
  assert.equal(run(['cri', 'publisher', 'add', 'nope', '--bus', 'x']).status, 2);
  assert.equal(run(['cri', 'identity', '--domain', 'orders', '--stack', 'orders-api']).status, 0);

  const listed = JSON.parse(run(['cri', 'list', '--json']).stdout) as { identity: Record<string, string>; publishers: { prefix?: string }[] };
  assert.deepEqual(listed.identity, identity);
  assert.equal(listed.publishers.length, 2);

  const t = run(['cri', 'publisher', 'test', '@payments/charge']);
  assert.equal(t.status, 0);
  assert.match(t.stderr, /@payments\/ publisher/);

  const d = run(['cri', 'send', '@payments/charge', '--args', '{"amount":10}', '--dry-run']);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stderr, /bus\s+payments/);
  assert.match(d.stderr, /"amount":10/);
  assert.match(d.stderr, /would send/);
  assert.equal(d.stdout, '');

  assert.equal(run(['cri', 'send', 'users/create', '--args', '{"a":1}']).status, 2, 'no terminal and no --yes');
  assert.equal(run(['cri', 'send', 'users/create', '--args', '[1]', '--dry-run']).status, 1);
  assert.equal(run(['cri', 'send', 'users/create', '--args', '{"_meta":{}}', '--dry-run']).status, 1);
  const viaStdin = run(['cri', 'send', 'users/create', '--args-file', '-', '--dry-run'], '{"name":"A"}');
  assert.equal(viaStdin.status, 0, viaStdin.stderr);

  assert.equal(run(['cri', 'publisher', 'remove', 'default']).status, 0);
  const none = run(['cri', 'send', 'users/create', '--dry-run']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no publisher/);
  assert.equal(run(['cri', 'bogus']).status, 2);
});
