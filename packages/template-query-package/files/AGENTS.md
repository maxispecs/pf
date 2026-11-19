# @pulpfixer/query-{{name}}

A **query package** for pf: a plugin that turns named SQL queries on one database into the command `pf {{name}}`. It holds only the queries and what is done with their rows. Connections, drivers and credentials belong to pf (`pf db`), never to this repo.

- Command: `pf {{name}} <query> [--param value ...] [--json|--csv] [--db <connection>]`
- Connection it uses by default: `{{connection}}` (users create it with `pf db add {{connection}} --driver {{driver}}`)
- Database: {{driver}}
- API: `@pulpfixer/plugin-db/api` (`defineQueries`, `sql`, the `Db` methods). The guide is the "Writing a query package" page of the pf docs (`pf docs`).
- The `query-package` skill (bundled with pf) walks through the work: `pf skill query-package`, or `pf_skill` from the agent.

## Layout

| Path | What |
|------|------|
| `src/index.ts` | `export default defineQueries({ ... })`: every query lives here (split into `src/queries/*.ts` when it grows, and import them) |
| `tests/*.test.ts` | tests with a fake driver: they check the SQL each query sends and what it does with the rows. No database needed |
| `pulpfixer.json` | pf's view of the repo (keep its `id`; `pf rp` owns it) |
| `.npmrc` | cellars registry; the token comes from `${NPM_TOKEN}`. Never write a token into any file |

## Writing queries

Each entry in `queries` is `{ summary, params?, writes?, run(db, params, { ctx, dryRun }) }`.

```ts
monthly: {
  summary: 'Recognized revenue per product for a month',
  params: { month: { required: true, help: 'YYYY-MM' }, limit: { type: 'number', default: 50 } },
  run: (db, { month, limit }) => db.all(sql`
    SELECT product, SUM(amount) AS recognized
    FROM revenue_schedule
    WHERE period = ${month}
    GROUP BY product
    ORDER BY recognized DESC
    LIMIT ${limit}`),
},
```

Rules:

1. **SQL only through the `sql` tagged template.** Every `${value}` is a bound parameter. Use `sql.id(name)` for a table or column name chosen at run time, and only from a fixed list (a param with `choices`). `sql.raw` is only for fixed text written here, never for a value from a flag.
2. **Read-only unless it says otherwise.** A query that changes data needs `writes: true`: pf then asks for confirmation and honors `--dry-run`. Without it, `db.exec`, `db.insert`, `db.update` and `db.deleteFrom` throw. `update` and `deleteFrom` need a where.
3. **No connection details or secrets in the code**: no hosts, users, passwords or DSNs. The connection name (`{{connection}}`) is the only link to the database; `--db` picks another.
4. **The schema comes from the user.** You have no database tools and must not try to connect: ask for the table definitions (DDL, a migration folder, or a description) and for what each query should answer. Do not guess column names.
5. **Params**: a camelCase name is a kebab flag (`productId` is `--product-id`); `type` is `string` (default), `number` or `boolean`; `required`, `default`, `help` and `choices` as needed.
6. **Money and big numbers**: DECIMAL and BIGINT values may arrive as strings (MySQL, PostgreSQL `numeric` / `int8`). Keep them strings or convert them deliberately, never through floating point.
7. **Post-processing** is plain TypeScript in `run`: return an array of row objects (or what `db.query` gives).
8. **No third-party runtime dependencies.** `@pulpfixer/plugin-db` and `@pulpfixer/kit` are the only ones.

## Testing

Every query gets a test in `tests/` that registers the fake driver, runs `pf {{name}} <query>` through `plugin.commands[0].run(...)` and checks both the SQL text and values sent (`log[i]`) and the output. Answer the fake with rows shaped like the real table. Run `pnpm test` and `pnpm typecheck` (or `pf test`, `pf_run test`).

## Versions and publishing

- After a change, bump the version with `pf ver` (it lists the ready-to-run bump commands; `pf_bump` from the agent): `minor`, or `major` when a query is renamed or removed or its flags change incompatibly. Never edit the version by hand.
- Publishing goes to cellars as `@pulpfixer/query-{{name}}`: `pf ps` (runs `publish:cellars`: typecheck, test, `pnpm publish`). It always asks first. **Publish only when the user asks.**
- Cellars treats `@pulpfixer/query-` as a **clearance** prefix: the package is created restricted on its first publish, so only users with the clearance role can see or install it (`pf plugin install query-{{name}}`); others get a 404. A cellars administrator must have marked the prefix before the first publish.
