import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { IoContext } from '@pulpfixer/kit/io';
import { eventbridgeAdapter } from '../src/adapter.js';
import { buildEntries, buildEntry, checkTarget, chunkEntries, MAX_BYTES, parsePutResult, putEventsArgv, type PutEntry } from '../src/events.js';
import { mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, '..', 'pulpfixer', 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const ev = (over: Record<string, unknown> = {}) => ({ source: 'acme.orders', detailType: 'OrderPlaced', detail: { id: 1 }, ...over });

// ---- pure ----

test('buildEntry makes a put-events entry', () => {
  const e = buildEntry(ev({ bus: 'orders', resources: ['arn:aws:s3:::b'], time: '2026-11-24T15:00:00+01:00' }));
  assert.deepEqual(e, {
    Source: 'acme.orders',
    DetailType: 'OrderPlaced',
    Detail: '{"id":1}',
    EventBusName: 'orders',
    Resources: ['arn:aws:s3:::b'],
    Time: '2026-11-24T14:00:00.000Z',
  });
  assert.deepEqual(buildEntry(ev()), { Source: 'acme.orders', DetailType: 'OrderPlaced', Detail: '{"id":1}' });
});

test('buildEntry refuses what EventBridge would', () => {
  assert.throws(() => buildEntry(ev({ source: '' })), /source is required/);
  assert.throws(() => buildEntry(ev({ detailType: ' ' })), /detail-type is required/);
  assert.throws(() => buildEntry(ev({ source: 'aws.s3' })), /reserved for AWS/);
  assert.throws(() => buildEntry(ev({ detail: [1] })), /must be a JSON object/);
  assert.throws(() => buildEntry(ev({ detail: null })), /must be a JSON object/);
  assert.throws(() => buildEntry(ev({ bus: '--profile' })), /not a valid event bus/);
  assert.throws(() => buildEntry(ev({ time: 'yesterday' })), /not a valid time/);
  assert.throws(() => buildEntry(ev({ detail: { big: 'x'.repeat(MAX_BYTES) } })), /256 KB/);
  assert.throws(() => buildEntries([ev(), ev({ source: '' })]), /event 2: a source is required/);
});

test('buildEntry writes bigint as text', () => {
  assert.equal(buildEntry(ev({ detail: { n: 12345678901234567890n } })).Detail, '{"n":"12345678901234567890"}');
});

test('chunkEntries splits by 10 entries and by size', () => {
  const small = buildEntries(Array.from({ length: 25 }, () => ev()));
  assert.deepEqual(chunkEntries(small).map((c) => c.length), [10, 10, 5]);
  assert.deepEqual(chunkEntries([]), []);
  const big: PutEntry[] = buildEntries(Array.from({ length: 3 }, () => ev({ detail: { x: 'y'.repeat(120 * 1024) } })));
  assert.deepEqual(chunkEntries(big).map((c) => c.length), [2, 1]);
});

test('putEventsArgv reads the entries from a file and passes profile and region', () => {
  assert.deepEqual(putEventsArgv('/tmp/e.json', { profile: 'p', region: 'eu-west-1' }), [
    'aws', 'events', 'put-events', '--entries', 'file:///tmp/e.json', '--output', 'json', '--profile', 'p', '--region', 'eu-west-1',
  ]);
  assert.throws(() => checkTarget({ profile: '--debug' }), /not a valid profile/);
  assert.throws(() => checkTarget({ region: 'x y' }), /not a valid region/);
});

test('parsePutResult reads ids and failed entries', () => {
  const ok = parsePutResult(JSON.stringify({ FailedEntryCount: 0, Entries: [{ EventId: 'a' }, { EventId: 'b' }] }), 2);
  assert.deepEqual(ok, { ids: ['a', 'b'], failures: [] });
  const part = parsePutResult(JSON.stringify({ FailedEntryCount: 1, Entries: [{ EventId: 'a' }, { ErrorCode: 'InternalFailure', ErrorMessage: 'boom' }] }), 2);
  assert.deepEqual(part.ids, ['a']);
  assert.deepEqual(part.failures, [{ index: 1, code: 'InternalFailure', message: 'boom' }]);
  assert.throws(() => parsePutResult('nope', 1), /unexpected output/);
  assert.throws(() => parsePutResult(JSON.stringify({ Entries: [] }), 1), /wrong number/);
});

// ---- with a fake aws on PATH ----

/** Logs its arguments and the entries file; answers with ids, or fails the first entry when FAKE_FAIL is set. */
function fakeAws(): { bin: string; log: string; payload: string } {
  const dir = mkRepo({});
  const log = path.join(dir, 'calls.log');
  const payload = path.join(dir, 'payload.log');
  const script = `#!/bin/sh
echo "$@" >> "${log}"
if [ "$2" = put-events ]; then
  f="\${4#file://}"
  cat "$f" >> "${payload}"; echo >> "${payload}"
  "${process.execPath}" -e '
    const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const fail = process.env.FAKE_FAIL;
    const entries = e.map((_, i) => (fail && i === 0 ? { ErrorCode: "InternalFailure", ErrorMessage: "boom" } : { EventId: "id-" + i }));
    console.log(JSON.stringify({ FailedEntryCount: entries.filter((x) => x.ErrorCode).length, Entries: entries }));
  ' "$f"
fi
`;
  fs.writeFileSync(path.join(dir, 'aws'), script, { mode: 0o755 });
  return { bin: dir, log, payload };
}

function pf(cwd: string, env: Record<string, string>, args: string[], input?: string) {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', ...env };
  delete e.FORCE_COLOR;
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env: e, ...(input !== undefined ? { input } : {}) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const base = ['events', 'put', '--source', 'acme.orders', '--type', 'OrderPlaced'];

test('pf events put --dry-run shows the event and calls nothing', () => {
  const fake = fakeAws();
  const env = { PF_HOME: mkRepo({}), PATH: `${fake.bin}${path.delimiter}${process.env.PATH}` };
  const r = pf(mkRepo({}), env, [...base, '--detail', '{"id":7}', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /would send 1 event/);
  assert.match(r.err, /OrderPlaced/);
  assert.equal(fs.existsSync(fake.log), false);
});

test('pf events put needs --yes without a terminal', () => {
  const fake = fakeAws();
  const env = { PF_HOME: mkRepo({}), PATH: `${fake.bin}${path.delimiter}${process.env.PATH}` };
  const r = pf(mkRepo({}), env, base);
  assert.equal(r.code, 2);
  assert.match(r.err, /--yes/);
  assert.equal(fs.existsSync(fake.log), false);
});

test('pf events put rejects bad input with exit 2', () => {
  const env = { PF_HOME: mkRepo({}) };
  const cwd = mkRepo({});
  assert.equal(pf(cwd, env, ['events', 'put', '--type', 't', '--yes']).code, 2);
  assert.equal(pf(cwd, env, ['events', 'put', '--source', 'aws.ec2', '--type', 't', '--yes']).code, 2);
  assert.equal(pf(cwd, env, [...base, '--detail', '[1]', '--yes']).code, 2);
  assert.equal(pf(cwd, env, [...base, '--detail', '{}', '--detail-file', 'x.json', '--yes']).code, 2);
  assert.equal(pf(cwd, env, [...base, '--profile', '--debug', '--yes']).code, 2);
  assert.equal(pf(cwd, env, [...base, 'extra', '--yes']).code, 2);
  assert.equal(pf(cwd, env, ['events', 'nope']).code, 2);
});

test('pf events put sends the event and prints its id', () => {
  const fake = fakeAws();
  const env = { PF_HOME: mkRepo({}), PATH: `${fake.bin}${path.delimiter}${process.env.PATH}` };
  const r = pf(mkRepo({}), env, [...base, '--detail', '{"id":7}', '--bus', 'orders', '--resource', 'arn:a', '--resource', 'arn:b', '--profile', 'p', '--region', 'eu-west-1', '--yes']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'id-0');
  assert.match(fs.readFileSync(fake.log, 'utf8'), /events put-events --entries file:\/\/\S+ --output json --profile p --region eu-west-1/);
  const sent = JSON.parse(fs.readFileSync(fake.payload, 'utf8')) as PutEntry[];
  assert.deepEqual(sent, [{ Source: 'acme.orders', DetailType: 'OrderPlaced', Detail: '{"id":7}', EventBusName: 'orders', Resources: ['arn:a', 'arn:b'] }]);
});

test('pf events put reads the detail from standard input', () => {
  const fake = fakeAws();
  const env = { PF_HOME: mkRepo({}), PATH: `${fake.bin}${path.delimiter}${process.env.PATH}` };
  const r = pf(mkRepo({}), env, [...base, '--detail-file', '-', '--yes'], '{"from":"stdin"}');
  assert.equal(r.code, 0, r.err);
  assert.equal((JSON.parse(fs.readFileSync(fake.payload, 'utf8')) as PutEntry[])[0]!.Detail, '{"from":"stdin"}');
});

test('pf events put exits 1 when EventBridge fails the entry, even though aws exits 0', () => {
  const fake = fakeAws();
  const env = { PF_HOME: mkRepo({}), FAKE_FAIL: '1', PATH: `${fake.bin}${path.delimiter}${process.env.PATH}` };
  const r = pf(mkRepo({}), env, [...base, '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /InternalFailure - boom/);
  assert.match(r.err, /0 of 1 events were sent/);
});

// ---- the eventbridge adapter ----

function io(dryRun: boolean): { io: IoContext; lines: string[] } {
  const lines: string[] = [];
  return { io: { ctx: {} as IoContext['ctx'], dryRun, log: (l) => lines.push(l), batchSize: 500 }, lines };
}

async function withFakePath<T>(fake: { bin: string }, env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env.PATH = `${fake.bin}${path.delimiter}${process.env.PATH}`;
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    process.env.PATH = saved.PATH;
  }
}

test('the eventbridge sink checks its configuration', async () => {
  const { io: ctx } = io(false);
  await assert.rejects(() => eventbridgeAdapter.sink!({ source: 'aws.x', detailType: 't' }, ctx), /reserved for AWS/);
  await assert.rejects(() => eventbridgeAdapter.sink!({ source: 'a.b' }, ctx), /detailType or detailTypeField/);
  await assert.rejects(() => eventbridgeAdapter.sink!({ source: 'a.b', detailType: 't', detailTypeField: 'k' }, ctx), /detailType or detailTypeField/);
  await assert.rejects(() => eventbridgeAdapter.sink!({ source: 'a.b', detailType: 't', profile: '--x' }, ctx), /not a valid profile/);
  await assert.rejects(() => eventbridgeAdapter.sink!({ source: 'a.b', detailType: 't', detail: [] }, ctx), /"row" or a list/);
  assert.equal(eventbridgeAdapter.describe({ source: 'a.b', detailType: 't' }), 'eventbridge default bus (source a.b)');
  assert.notEqual(eventbridgeAdapter.harmless, true);
});

test('the eventbridge sink sends one event per row when the pipe worked, 10 per call', async () => {
  const fake = fakeAws();
  const { io: ctx } = io(false);
  await withFakePath(fake, {}, async () => {
    const sink = await eventbridgeAdapter.sink!({ source: 'acme.orders', detailType: 'Row', bus: 'orders' }, ctx);
    await sink.write(Array.from({ length: 12 }, (_, i) => ({ id: i, name: `n${i}` })));
    assert.equal(fs.existsSync(fake.log), false, 'nothing is sent before close');
    await sink.close(true);
  });
  const calls = fs.readFileSync(fake.log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  const payloads = fs.readFileSync(fake.payload, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PutEntry[]);
  assert.deepEqual(payloads.map((p) => p.length), [10, 2]);
  assert.equal(payloads[0]![0]!.Detail, '{"id":0,"name":"n0"}');
  assert.equal(payloads[0]![0]!.EventBusName, 'orders');
});

test('the eventbridge sink sends nothing on a failed pipe or a dry run', async () => {
  const fake = fakeAws();
  await withFakePath(fake, {}, async () => {
    const failed = await eventbridgeAdapter.sink!({ source: 'acme.orders', detailType: 'Row' }, io(false).io);
    await failed.write([{ id: 1 }]);
    await failed.close(false);

    const dry = io(true);
    const sink = await eventbridgeAdapter.sink!({ source: 'acme.orders', detailType: 'Row' }, dry.io);
    await sink.write([{ id: 1 }, { id: 2 }]);
    await sink.close(true);
    assert.deepEqual(dry.lines, ['would send 2 events to the default bus']);
  });
  assert.equal(fs.existsSync(fake.log), false);
});

test('the eventbridge sink takes detail columns and the detail-type from a column', async () => {
  const fake = fakeAws();
  await withFakePath(fake, {}, async () => {
    const sink = await eventbridgeAdapter.sink!({ source: 'acme.orders', detailTypeField: 'kind', detail: ['id'] }, io(false).io);
    await sink.write([{ id: 1, kind: 'A', secret: 'x' }, { id: 2, kind: 'B', secret: 'y' }]);
    await sink.close(true);
    const bad = await eventbridgeAdapter.sink!({ source: 'acme.orders', detailTypeField: 'kind', detail: ['id'] }, io(false).io);
    await assert.rejects(() => bad.write([{ id: 1 }]), /row 1: the column "kind"/);
    const missing = await eventbridgeAdapter.sink!({ source: 'acme.orders', detailType: 't', detail: ['nope'] }, io(false).io);
    await assert.rejects(() => missing.write([{ id: 1 }]), /row 1 has no column "nope"/);
  });
  const sent = JSON.parse(fs.readFileSync(fake.payload, 'utf8')) as PutEntry[];
  assert.deepEqual(sent.map((e) => [e.DetailType, e.Detail]), [['A', '{"id":1}'], ['B', '{"id":2}']]);
});

test('the eventbridge sink reports how many events were sent when EventBridge fails one', async () => {
  const fake = fakeAws();
  await withFakePath(fake, { FAKE_FAIL: '1' }, async () => {
    const sink = await eventbridgeAdapter.sink!({ source: 'acme.orders', detailType: 'Row' }, io(false).io);
    await sink.write([{ id: 1 }]);
    await assert.rejects(() => sink.close(true), /InternalFailure - boom[\s\S]*0 of 1 events were sent/);
  });
});
