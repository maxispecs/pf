import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ioRef, type Row } from '@pulpfixer/kit/io';
import { memorySink, memorySource } from '../src/adapters/memory.js';
import { definePipes, pipeUsage, type PipeDef } from '../src/define.js';
import { capture, ctx, freshAdapters, rows } from './helpers.js';

function pkg(pipes: Record<string, PipeDef>) {
  const plugin = definePipes({ name: 'etl', summary: 'Test pipes', pipes });
  const run = (...args: string[]) => capture(() => plugin.commands[0]!.run(ctx(), args));
  return { plugin, run };
}

test('definePipes validates names and run / transform', () => {
  assert.throws(() => definePipes({ name: 'Bad', summary: '', pipes: {} }), /pipe package name/);
  assert.throws(() => definePipes({ name: 'ok', summary: '', pipes: { 'Bad Name': { summary: '' } } }), /pipe name/);
  assert.throws(() => definePipes({ name: 'ok', summary: '', pipes: { x: { summary: '', run: () => 1, transform: (r) => r } } }), /both run and transform/);
});

test('it is a plugin with one command and a menu entry', () => {
  const { plugin } = pkg({ copy: { summary: 'Copy' } });
  assert.equal(plugin.name, 'etl');
  assert.equal(plugin.commands.length, 1);
  assert.equal(plugin.commands[0]!.name, 'etl');
  assert.equal(plugin.entries!(ctx())[0]!.name, 'etl');
});

test('the command lists the pipes with their flags', async () => {
  freshAdapters();
  const { run } = pkg({
    copy: { summary: 'Copy rows', params: { limit: { type: 'number' }, tag: { required: true }, all: { type: 'boolean' } } },
    other: { summary: 'Another' },
  });
  const r = await run();
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Test pipes/);
  assert.match(r.stdout, /pf etl copy \[--limit <limit>\] --tag <tag> \[--all\] \[--dry-run\] \[--yes\]/);
  assert.match(r.stdout, /Another/);
  assert.equal((await run('list')).code, 0);
  assert.equal(pipeUsage('etl', 'other', { summary: '' }), 'pf etl other [--dry-run] [--yes]');
});

test('a pipe with no run copies its one input to every output through transform', async () => {
  freshAdapters();
  const out1: Row[] = [];
  const out2: Row[] = [];
  const { run } = pkg({
    copy: {
      summary: 'Copy',
      params: { factor: { type: 'number', default: 10 } },
      inputs: () => ({ src: memorySource(rows(3)) }),
      outputs: { a: memorySink(out1), b: memorySink(out2) },
      transform: (row, { factor }) => (row.id === 2 ? null : row.id === 3 ? [{ ...row, x: 1 }, { ...row, x: 2 }] : { ...row, id: (row.id as number) * factor }),
    },
  });
  const r = await run('copy', '--factor', '100');
  assert.equal(r.code, 0, r.stderr);
  const expected = [{ id: 100, name: 'n1' }, { id: 3, name: 'n3', x: 1 }, { id: 3, name: 'n3', x: 2 }];
  assert.deepEqual(out1, expected);
  assert.deepEqual(out2, expected);
  assert.match(r.stderr, /read src 3 rows/);
  assert.match(r.stderr, /wrote a 3, b 3 rows/);
  assert.equal(r.stdout, '');
});

test('without transform the rows are copied as they are, and inputs may depend on params', async () => {
  freshAdapters();
  const out: Row[] = [];
  const { run } = pkg({
    copy: { summary: 'Copy', params: { n: { type: 'number', default: 2 } }, inputs: ({ n }) => ({ s: memorySource(rows(n)) }), outputs: { d: memorySink(out) } },
  });
  assert.equal((await run('copy', '--n', '4')).code, 0);
  assert.deepEqual(out, rows(4));
});

test('a pipe with a run does the coupling itself, with from, params and the dry-run flag', async () => {
  freshAdapters();
  const left = [{ k: 1, l: 'a' }, { k: 2, l: 'b' }];
  const right = [{ k: 2, r: 'B' }, { k: 1, r: 'A' }];
  const out: Row[] = [];
  const seen: { dryRun?: boolean; tag?: string; batch?: number } = {};
  const { run } = pkg({
    join: {
      summary: 'Join',
      params: { tag: { default: 't' } },
      inputs: { left: memorySource(left), right: memorySource(right) },
      outputs: { joined: memorySink(out) },
      async run({ inputs, outputs, from, params, dryRun, log }) {
        seen.dryRun = dryRun;
        seen.tag = params.tag;
        log('joining');
        const byKey = new Map((await from(inputs.right!).collect()).map((r) => [r.k, r]));
        await from(inputs.left!).map((l) => ({ ...l, ...byKey.get(l.k) })).to(outputs.joined!);
      },
    },
  });
  const r = await run('join', '--batch-size', '1', '--tag', 'z');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(out, [{ k: 1, l: 'a', r: 'A' }, { k: 2, l: 'b', r: 'B' }]);
  assert.deepEqual(seen, { dryRun: false, tag: 'z' });
  assert.match(r.stderr, /joining/);
});

test('a dry run reaches the pipe', async () => {
  freshAdapters();
  let dry: boolean | undefined;
  const { run } = pkg({ p: { summary: 'P', outputs: {}, run: ({ dryRun }) => void (dry = dryRun) } });
  assert.equal((await run('p', '--dry-run')).code, 0);
  assert.equal(dry, true);
});

test('usage mistakes exit 2 with the usage line', async () => {
  freshAdapters();
  const { run } = pkg({ copy: { summary: 'Copy', params: { tag: { required: true } } } });
  const unknown = await run('nope');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no pipe "nope" in etl. Have: copy/);
  const missing = await run('copy');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--tag is required/);
  assert.match(missing.stderr, /usage .*pf etl copy --tag <tag>/);
  const extra = await run('copy', '--tag', 'x', 'stray');
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /unexpected stray/);
  const size = await run('copy', '--tag', 'x', '--batch-size', '0');
  assert.equal(size.code, 2);
  assert.match(size.stderr, /--batch-size/);
});

test('failures exit 1: missing adapter with its hint, wrong shape, a thrown error', async () => {
  freshAdapters();
  const { run } = pkg({
    missing: { summary: 'M', inputs: { a: ioRef('ghost', {}) } },
    two: { summary: 'T', inputs: { a: memorySource([]), b: memorySource([]) }, outputs: { o: memorySink([]) } },
    none: { summary: 'N', inputs: { a: memorySource([]) } },
    boom: { summary: 'B', inputs: { a: memorySource(rows(1)) }, outputs: { o: memorySink([]) }, transform: () => { throw new Error('bad row'); } },
    'bad-refs': { summary: 'R', inputs: () => 5 as never },
  });
  const missing = await run('missing');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no IO adapter "ghost"/);
  assert.match(missing.stderr, /pf plugin install io-ghost/);
  const two = await run('two');
  assert.equal(two.code, 1);
  assert.match(two.stderr, /has 2 inputs.*write a run\(\)/);
  assert.match((await run('none')).stderr, /has no outputs/);
  const boom = await run('boom');
  assert.equal(boom.code, 1);
  assert.match(boom.stderr, /etl boom failed: bad row/);
  assert.match((await run('bad-refs')).stderr, /inputs must be an object/);
});
