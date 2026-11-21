import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Flow, collect, concat, count, from, fromRows } from '../src/flow.js';
import { fakeSink, fakeSource, rows } from './helpers.js';

test('from takes an array, a source, batches and a flow', async () => {
  assert.deepEqual(await from(rows(3)).collect(), rows(3));
  assert.deepEqual(await from(fakeSource([rows(2), rows(1)])).collect(), [...rows(2), ...rows(1)]);
  const batches = (async function* () {
    yield rows(2);
  })();
  assert.deepEqual(await from(batches).collect(), rows(2));
  const f = from(rows(1));
  assert.equal(from(f), f);
  assert.throws(() => from(42 as never), /from\(\) takes/);
});

test('an array is cut into batches of the given size', async () => {
  const seen: number[] = [];
  const sink = fakeSink();
  await from(rows(5), 2).tap(() => undefined).to(sink);
  for (const b of sink.written) seen.push(b.length);
  assert.deepEqual(seen, [2, 2, 1]);
  assert.throws(() => from(rows(1), 0), /at least 1/);
});

test('map, filter, flatMap and tap work row by row with the row index', async () => {
  const idx: number[] = [];
  const got = await from(rows(4), 2)
    .tap((_r, i) => void idx.push(i))
    .filter((r) => (r.id as number) % 2 === 0)
    .map((r) => ({ ...r, big: (r.id as number) * 10 }))
    .flatMap((r) => [r, { ...r, copy: true }])
    .collect();
  assert.deepEqual(idx, [0, 1, 2, 3]);
  assert.deepEqual(got, [
    { id: 2, name: 'n2', big: 20 },
    { id: 2, name: 'n2', big: 20, copy: true },
    { id: 4, name: 'n4', big: 40 },
    { id: 4, name: 'n4', big: 40, copy: true },
  ]);
});

test('async callbacks are awaited', async () => {
  const got = await from(rows(2)).map(async (r) => ({ ...r, x: await Promise.resolve(1) })).collect();
  assert.deepEqual(got.map((r) => r.x), [1, 1]);
});

test('map and flatMap refuse something that is not a row', async () => {
  await assert.rejects(from(rows(1)).map(() => null as never).collect(), /map must return a row.*filter/);
  await assert.rejects(from(rows(1)).flatMap(() => ({}) as never).collect(), /array of rows/);
});

test('pick, omit and rename change columns', async () => {
  const one = [{ a: 1, b: 2, c: 3 }];
  assert.deepEqual(await from(one).pick('c', 'a', 'zzz').collect(), [{ c: 3, a: 1 }]);
  assert.deepEqual(await from(one).omit('b').collect(), [{ a: 1, c: 3 }]);
  assert.deepEqual(await from(one).rename({ a: 'x', c: 'z' }).collect(), [{ x: 1, b: 2, z: 3 }]);
});

test('take stops reading the source', async () => {
  let pulled = 0;
  const source = (async function* () {
    for (let i = 0; i < 10; i++) {
      pulled++;
      yield rows(2);
    }
  })();
  const got = await from(source).take(3).collect();
  assert.equal(got.length, 3);
  assert.equal(pulled, 2);
  assert.deepEqual(await from(rows(5)).take(0).collect(), []);
  assert.throws(() => from(rows(1)).take(-1), /0 or more/);
});

test('batch regroups rows', async () => {
  const sink = fakeSink();
  await from(rows(7), 3).batch(4).to(sink);
  assert.deepEqual(sink.written.map((b) => b.length), [4, 3]);
  assert.throws(() => from(rows(1)).batch(0), /at least 1/);
});

test('to writes every batch to every sink, in order, and counts', async () => {
  const a = fakeSink();
  const b = fakeSink();
  const result = await from(rows(5), 2).to(a, b);
  assert.deepEqual(result, { rows: 5, batches: 3 });
  assert.deepEqual(a.written, b.written);
  assert.equal(a.closedWith, null, 'closing is up to whoever opened the sink');
  await assert.rejects(from(rows(1)).to(), /at least one sink/);
});

test('empty batches are not written', async () => {
  const sink = fakeSink();
  await from(fakeSource([[], rows(1), []])).to(sink);
  assert.equal(sink.written.length, 1);
});

test('a flow is read once', async () => {
  const f = from(rows(2));
  await f.count();
  await assert.rejects(f.collect(), /already used/);
  const g = from(rows(2));
  g.map((r) => r);
  assert.throws(() => g.filter(() => true), /already used/);
});

test('rows(), concat, collect, count and fromRows', async () => {
  const seen: unknown[] = [];
  for await (const r of from(rows(3), 2).rows()) seen.push(r.id);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(await collect(concat(rows(1), fakeSource([rows(2)]), from(rows(1)))).then((r) => r.map((x) => x.id)), [1, 1, 2, 1]);
  assert.equal(await count(from(rows(6), 4)), 6);
  const sink = fakeSink();
  await fromRows((function* () {
    for (const r of rows(5)) yield r;
  })(), 2).to(sink);
  assert.deepEqual(sink.written.map((b) => b.length), [2, 2, 1]);
  const asyncRows = (async function* () {
    yield { a: 1 };
  })();
  assert.deepEqual(await fromRows(asyncRows).collect(), [{ a: 1 }]);
});

test('a Flow is an async iterable of batches', async () => {
  const f: Flow = from(rows(3), 2);
  const sizes: number[] = [];
  for await (const b of f) sizes.push(b.length);
  assert.deepEqual(sizes, [2, 1]);
});
