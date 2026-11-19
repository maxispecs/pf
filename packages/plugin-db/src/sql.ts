import type { CompiledQuery, Dialect } from '@pulpfixer/kit/db';

/**
 * Safe SQL building. `sql` is a tagged template: every `${value}` becomes a bound parameter, never
 * text, so a value cannot change the statement. Names (tables, columns) go through `sql.id`, and only
 * `sql.raw` inserts text as it is (for SQL you wrote yourself).
 *
 *   sql`SELECT * FROM ${sql.id('orders')} WHERE month = ${month} AND id IN (${sql.list(ids)})`
 *
 * A fragment is dialect-neutral until `compile(fragment, dialect)` turns it into `$1` (Postgres) or `?`
 * (MySQL, SQLite) placeholders with the right identifier quoting.
 */

type Chunk = { t: 'text'; s: string } | { t: 'value'; v: unknown } | { t: 'id'; name: string };

export class SqlFragment {
  readonly chunks: readonly Chunk[];
  constructor(chunks: readonly Chunk[]) {
    this.chunks = chunks;
  }
  /** True when there is nothing in it (an empty `where`). */
  get empty(): boolean {
    return this.chunks.every((c) => c.t === 'text' && c.s.trim() === '');
  }
}

export type SqlLike = SqlFragment | string;

export class SqlError extends Error {}

const text = (s: string): Chunk => ({ t: 'text', s });

function append(into: Chunk[], v: unknown): void {
  if (v instanceof SqlFragment) {
    into.push(...v.chunks);
    return;
  }
  if (v === undefined) throw new SqlError('a value is undefined (use null for NULL)');
  if (Array.isArray(v)) throw new SqlError('an array cannot be one value: use sql.list(values) inside IN (...)');
  into.push({ t: 'value', v });
}

function build(strings: readonly string[], values: readonly unknown[]): SqlFragment {
  const chunks: Chunk[] = [];
  strings.forEach((s, i) => {
    if (s) chunks.push(text(s));
    if (i < values.length) append(chunks, values[i]);
  });
  return new SqlFragment(chunks);
}

function sqlTag(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return build(strings, values);
}

/** A table or column name, quoted for the dialect. `t.col` quotes both parts; a trailing `*` is left bare. */
function id(name: string): SqlFragment {
  if (typeof name !== 'string' || !name || /\0/.test(name)) throw new SqlError('an identifier must be a non-empty string');
  const parts = name.split('.');
  if (parts.some((p) => !p)) throw new SqlError(`"${name}" is not a valid identifier`);
  const chunks: Chunk[] = [];
  parts.forEach((p, i) => {
    if (i > 0) chunks.push(text('.'));
    chunks.push(p === '*' && i === parts.length - 1 && i > 0 ? text('*') : { t: 'id', name: p });
  });
  return new SqlFragment(chunks);
}

/** SQL text inserted as written. Only for text you control, never for input. */
function raw(s: string): SqlFragment {
  return new SqlFragment([text(s)]);
}

/** Join fragments (or values) with a separator, `, ` by default. */
function join(items: readonly unknown[], separator = ', '): SqlFragment {
  const chunks: Chunk[] = [];
  items.forEach((item, i) => {
    if (i > 0) chunks.push(text(separator));
    append(chunks, item);
  });
  return new SqlFragment(chunks);
}

/** `?, ?, ?` for a list of values: `IN (${sql.list(ids)})`. An empty list is an error (IN () is invalid SQL). */
function list(values: readonly unknown[]): SqlFragment {
  if (!Array.isArray(values) || values.length === 0) throw new SqlError('sql.list needs at least one value');
  return join(values.map((v) => (v instanceof SqlFragment ? v : new SqlFragment([{ t: 'value', v }]))));
}

export const sql = Object.assign(sqlTag, { id, raw, join, list });

/** A fragment from a fragment or a plain statement (taken as written, no parameters). */
export function toFragment(q: SqlLike): SqlFragment {
  return typeof q === 'string' ? raw(q) : q;
}

const quoteFor = (dialect: Dialect, name: string): string =>
  dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

/** Turn a fragment into text with the dialect's placeholders, plus the values in order. */
export function compile(q: SqlLike, dialect: Dialect): CompiledQuery {
  const values: unknown[] = [];
  let out = '';
  for (const c of toFragment(q).chunks) {
    if (c.t === 'text') out += c.s;
    else if (c.t === 'id') out += quoteFor(dialect, c.name);
    else {
      values.push(c.v);
      out += dialect === 'postgres' ? `$${values.length}` : '?';
    }
  }
  return { text: out.trim(), values };
}

export type Row = Record<string, unknown>;

const keysOf = (what: string, row: Row): string[] => {
  const keys = Object.keys(row);
  if (keys.length === 0) throw new SqlError(`${what}: no columns given`);
  return keys;
};

const cell = (v: unknown): SqlFragment => {
  if (v instanceof SqlFragment) return v;
  if (v === undefined) throw new SqlError('a value is undefined (use null for NULL)');
  return new SqlFragment([{ t: 'value', v }]);
};

/**
 * `a = ? AND b IS NULL AND c IN (?, ?)` from `{ a: 1, b: null, c: [1, 2] }`. An empty list matches nothing
 * (`1 = 0`). Without the `WHERE` keyword, so it can sit inside other conditions.
 */
export function conditions(where: Row): SqlFragment {
  const parts = Object.entries(where).map(([k, v]) => {
    if (v === null) return sql`${id(k)} IS NULL`;
    if (Array.isArray(v)) return v.length === 0 ? raw('1 = 0') : sql`${id(k)} IN (${list(v)})`;
    return sql`${id(k)} = ${cell(v)}`;
  });
  return join(parts, ' AND ');
}

/** `WHERE ...` from an object (see `conditions`), or nothing for an empty object. */
export function where(w: Row | SqlFragment): SqlFragment {
  const c = w instanceof SqlFragment ? w : conditions(w);
  return c.empty ? raw('') : sql`WHERE ${c}`;
}

export interface InsertOptions {
  /** `RETURNING <columns>` (Postgres, SQLite, MariaDB; MySQL has no RETURNING). */
  returning?: string | string[];
}

/** `INSERT INTO t (a, b) VALUES (?, ?), (?, ?)`. Every row must have the same columns. */
export function insert(table: string, rows: Row | Row[], opts: InsertOptions = {}): SqlFragment {
  const list_ = Array.isArray(rows) ? rows : [rows];
  if (list_.length === 0) throw new SqlError('insert: no rows given');
  const columns = keysOf('insert', list_[0]!);
  const wanted = [...columns].sort().join('\0');
  for (const r of list_) {
    if ([...Object.keys(r)].sort().join('\0') !== wanted) throw new SqlError('insert: every row needs the same columns');
  }
  const tuples = list_.map((r) => sql`(${join(columns.map((k) => cell(r[k])))})`);
  const ret = opts.returning ? (Array.isArray(opts.returning) ? opts.returning : [opts.returning]) : [];
  return sql`INSERT INTO ${id(table)} (${join(columns.map((k) => id(k)))}) VALUES ${join(tuples)}${ret.length ? sql` RETURNING ${join(ret.map((k) => id(k)))}` : raw('')}`;
}

function requireWhere(what: string, w: Row | SqlFragment): SqlFragment {
  const c = w instanceof SqlFragment ? w : conditions(w);
  if (c.empty) throw new SqlError(`${what} needs a where (it would change every row)`);
  return c;
}

/** `UPDATE t SET a = ?, b = ? WHERE ...`. The where is required: an update of every row must be written as raw SQL. */
export function update(table: string, set: Row, w: Row | SqlFragment): SqlFragment {
  const columns = keysOf('update', set);
  const assignments = columns.map((k) => sql`${id(k)} = ${cell(set[k])}`);
  return sql`UPDATE ${id(table)} SET ${join(assignments)} WHERE ${requireWhere('update', w)}`;
}

/** `DELETE FROM t WHERE ...`. The where is required. */
export function deleteFrom(table: string, w: Row | SqlFragment): SqlFragment {
  return sql`DELETE FROM ${id(table)} WHERE ${requireWhere('deleteFrom', w)}`;
}
