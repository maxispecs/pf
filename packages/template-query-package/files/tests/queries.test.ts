import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { makeSession, registerDbDrivers, type CompiledQuery, type DbDriver, type QueryResult } from '@pulpfixer/kit/db';
import { putConnection } from '@pulpfixer/plugin-db';
import plugin from '../src/index.js';

// A throwaway pf home: the tests never see the real connections.
process.env.PF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'query-{{name}}-test-'));
process.env.NO_COLOR = '1';

/** A driver that runs nothing: it records each statement and answers with `respond`. */
function fakeDriver(respond: (q: CompiledQuery) => QueryResult) {
  const log: CompiledQuery[] = [];
  const driver: DbDriver = {
    id: 'fake',
    label: 'Fake',
    dialect: '{{driver}}' as DbDriver['dialect'],
    forms: [{ id: 'params', label: 'Nothing to ask', fields: [] }],
    describe: () => 'fake',
    connect: async () =>
      makeSession(
        async (q) => {
          log.push(q);
          return respond(q);
        },
        async () => undefined,
      ),
  };
  registerDbDrivers([driver]);
  putConnection('{{connection}}', { driver: 'fake', form: 'params', params: {}, secrets: {} });
  return log;
}

/** Run `pf {{name}} ...args` with stdout and stderr captured. */
async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (err.push(String(s)), true)) as typeof process.stderr.write;
  try {
    const code = await plugin.commands[0]!.run(buildContext(os.tmpdir()), args);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test('pf {{name}} lists its queries', async () => {
  fakeDriver(() => ({ rows: [] }));
  const r = await run();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /pf {{name}} ping/);
});

test('ping returns the server time', async () => {
  const log = fakeDriver(() => ({ rows: [{ now: '2026-01-01 00:00:00' }] }));
  const r = await run('ping', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ now: '2026-01-01 00:00:00' }]);
  assert.equal(log[0]!.text, 'SELECT CURRENT_TIMESTAMP AS now');
});
