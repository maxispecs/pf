// Tables the workbench refuses to touch, whatever the AWS profile allows (the staging "sdlc" profile is an
// admin). Matched case-insensitively against the table or index name in FROM / INTO / UPDATE / JOIN.
// Edit this list to change what is excluded; there is deliberately no switch to turn it off per call.
import { compile } from '@pulpfixer/plugin-db/api';

export const BLOCKED_TABLES = [/auth/i, /refresh[-_]?tokens?/i];

/** The first blocked table or index a PartiQL statement names, or null. */
export function blockedTable(statement) {
  const re = /\b(?:FROM|INTO|UPDATE|JOIN)\s+((?:"[^"]*"|[\w.-]+)(?:\s*\.\s*(?:"[^"]*"|[\w-]+))?)/gi;
  for (const m of statement.matchAll(re)) {
    const name = m[1].replace(/"/g, '');
    if (BLOCKED_TABLES.some((p) => p.test(name))) return name;
  }
  return null;
}

/** Throws if a table name (as given to insert / update / deleteFrom) is blocked. */
export function assertTableAllowed(name) {
  if (BLOCKED_TABLES.some((p) => p.test(String(name)))) refuse(String(name));
}

function refuse(name) {
  throw new Error(`"${name}" is an excluded table (auth / tokens): the workbench will not read or change it. See lib/guard.mjs`);
}

/** A Db whose every statement is checked first; nothing reaches DynamoDB for a blocked table. */
export function guarded(db) {
  const text = (q) => (typeof q === 'string' ? q : compile(q, db.dialect).text);
  const check = (q) => {
    const hit = blockedTable(text(q));
    if (hit) refuse(hit);
  };
  return {
    ...db,
    query: (q) => (check(q), db.query(q)),
    all: (q) => (check(q), db.all(q)),
    one: (q) => (check(q), db.one(q)),
    value: (q) => (check(q), db.value(q)),
    exec: (q) => (check(q), db.exec(q)),
    insert: (table, rows, o) => (assertTableAllowed(table), db.insert(table, rows, o)),
    update: (table, set, where) => (assertTableAllowed(table), db.update(table, set, where)),
    deleteFrom: (table, where) => (assertTableAllowed(table), db.deleteFrom(table, where)),
    transaction: (fn) => db.transaction((tx) => fn(guarded(tx))),
  };
}
