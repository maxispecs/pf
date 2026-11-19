import { makeSession, type CompiledQuery, type ConnectionForm, type ConnectionParams, type DbDriver, type QueryResult } from '@pulpfixer/kit/db';
import type { Plugin } from '@pulpfixer/kit/plugin';

const FORMS: ConnectionForm[] = [
  {
    id: 'file',
    label: 'Database file',
    fields: [
      { key: 'path', label: 'File', kind: 'path', required: true, placeholder: '/path/to/data.db', help: 'created when missing, unless read-only' },
      { key: 'readonly', label: 'Read-only', kind: 'boolean', default: false },
    ],
  },
];

type SqlValue = null | number | bigint | string | Uint8Array;

/** node:sqlite takes null, numbers, bigints, strings and bytes: booleans and dates are converted, the rest is refused. Exported for tests. */
export function bindValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  throw new Error(`SQLite cannot bind a ${typeof v} value (use a string, number, boolean, Date or bytes)`);
}

const RETURNS_ROWS = /^\s*(select|with|pragma|values|explain)\b|\breturning\b/i;

interface Statement {
  columns?(): unknown[];
  all(...v: SqlValue[]): Record<string, unknown>[];
  run(...v: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** Run one statement and shape its result. Exported for tests. */
export function runStatement(stmt: Statement, q: CompiledQuery): QueryResult {
  const values = q.values.map(bindValue);
  const returnsRows = typeof stmt.columns === 'function' ? stmt.columns().length > 0 : RETURNS_ROWS.test(q.text);
  if (returnsRows) return { rows: stmt.all(...values).map((r) => ({ ...r })) };
  const r = stmt.run(...values);
  const insertId = Number(r.lastInsertRowid);
  return { rows: [], affected: Number(r.changes), ...(insertId && /^\s*(insert|replace)\b/i.test(q.text) ? { insertId } : {}) };
}

export const sqliteDriver: DbDriver = {
  id: 'sqlite',
  label: 'SQLite',
  dialect: 'sqlite',
  forms: FORMS,
  describe(_form, params) {
    return `${String(params.path ?? '?')}${params.readonly === true ? ' (read-only)' : ''}`;
  },
  async connect(_form, params: ConnectionParams) {
    const file = typeof params.path === 'string' ? params.path : '';
    if (!file) throw new Error('the database file is required');
    let sqlite: typeof import('node:sqlite');
    try {
      sqlite = await import('node:sqlite');
    } catch {
      throw new Error(`SQLite needs Node 22.13 or newer (this is ${process.version})`);
    }
    const db = new sqlite.DatabaseSync(file, { readOnly: params.readonly === true });
    return makeSession(
      async (q) => runStatement(db.prepare(q.text) as unknown as Statement, q),
      async () => db.close(),
    );
  },
};

const plugin: Plugin = {
  name: 'db-sqlite',
  api: 2,
  summary: 'SQLite driver for pf db',
  commands: [],
  dbDrivers: [sqliteDriver],
};
export default plugin;
