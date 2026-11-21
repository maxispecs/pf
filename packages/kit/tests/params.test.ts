import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagName, parseParams, takeBool } from '../src/params.js';

test('flag names are kebab case', () => {
  assert.equal(flagName('productId'), '--product-id');
  assert.equal(flagName('month'), '--month');
});

test('takeBool reads --x, --x=false and --no-x', () => {
  const a = ['--ssl', 'rest'];
  assert.equal(takeBool(a, '--ssl'), true);
  assert.deepEqual(a, ['rest']);
  assert.equal(takeBool(['--ssl=false'], '--ssl'), false);
  assert.equal(takeBool(['--no-ssl'], '--ssl'), false);
  assert.equal(takeBool([], '--ssl'), undefined);
});

test('parseParams applies types, defaults, choices and required', () => {
  const defs = {
    month: { required: true, help: 'YYYY-MM' },
    limit: { type: 'number' as const, default: 50 },
    kind: { choices: ['a', 'b'] },
    all: { type: 'boolean' as const },
  };
  assert.deepEqual(parseParams(defs, ['--month', '2026-10', '--all']), { values: { month: '2026-10', limit: 50, all: true } });
  assert.deepEqual(parseParams(defs, ['--month', 'm', '--limit', '7', '--kind', 'b']), { values: { month: 'm', limit: 7, kind: 'b' } });
  assert.match((parseParams(defs, []) as { error: string }).error, /--month is required \(YYYY-MM\)/);
  assert.match((parseParams(defs, ['--month', 'm', '--limit', 'x']) as { error: string }).error, /must be a number/);
  assert.match((parseParams(defs, ['--month', 'm', '--kind', 'z']) as { error: string }).error, /one of a, b/);
  assert.match((parseParams(defs, ['--month']) as { error: string }).error, /needs a value/);
  assert.deepEqual(parseParams(undefined, []), { values: {} });
});
