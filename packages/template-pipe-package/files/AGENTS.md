# @pulpfixer/pipe-{{name}}

A **pipe package** for pf: a plugin that turns scripted IO into the command `pf {{name}}`. A pipe declares where rows come from (inputs) and where they go (outputs) and you code the coupling in between. It holds only that code; connections, drivers and credentials belong to pf (`pf db`), never to this repo.

- Command: `pf {{name}} <pipe> [--param value ...] [--dry-run] [--yes] [--batch-size n]`
- Connection it uses by default: `{{connection}}` (users create it with `pf db add {{connection}}`), when an end is a database
- Sample pipe: `copy`, from a {{input}} input to a {{output}} output
- API: `@pulpfixer/plugin-io/api` (`definePipes`, `from`, the chain helpers, `memorySource` / `memorySink`), `@pulpfixer/plugin-db/api` (`dbSource`, `dbSink`, `sql`), `@pulpfixer/plugin-csv/api` (`csvSource`, `csvSink`). The guide is the "Writing a pipe package" page of the pf docs (`pf docs`).
- The `pipe-package` skill (bundled with pf) walks through the work: `pf skill pipe-package`, or `pf_skill` from the agent.

## Layout

| Path | What |
|------|------|
| `src/index.ts` | `export default definePipes({ ... })`: every pipe lives here (split into `src/pipes/*.ts` when it grows, and import them) |
| `tests/*.test.ts` | tests without a database: memory adapter for the logic, the fake driver for the SQL, temp files for CSV |
| `pulpfixer.json` | pf's view of the repo (keep its `id`; `pf rp` owns it) |
| `.npmrc` | cellars registry; the token comes from `${NPM_TOKEN}`. Never write a token into any file |

## Writing pipes

Each entry in `pipes` is `{ summary, params?, inputs, outputs, transform? , run? }`.

```ts
export: {
  summary: 'Recognized revenue of a month to a CSV file',
  params: { month: { required: true, help: 'YYYY-MM' }, out: { required: true } },
  inputs: ({ month }) => ({ revenue: dbSource({ connection: 'revrec', query: sql`SELECT product, amount FROM revenue_schedule WHERE period = ${month}` }) }),
  outputs: ({ out }) => ({ file: csvSink({ path: String(out) }) }),
  transform: (row) => ({ product: row.product, euros: Number(row.amount) / 100 }),
},
```

Without `run` the pipe copies its one input to every output, through `transform` when there is one (return a row, an array of rows, or `null` to drop it). When the coupling is more than that (several inputs, joins, splitting rows across outputs), write `run`:

```ts
async run({ inputs, outputs, from, log }) {
  const result = await from(inputs.orders!).filter((r) => r.paid === 1).map(shape).to(outputs.paid!, outputs.audit!);
  log(`${result.rows} orders`);
},
```

Rules:

1. **Declare every input and output** in `inputs` / `outputs` with an adapter builder. pf shows them, asks before writing (`--yes` skips it, a dry run never asks) and closes them. Never open a file or a connection yourself in `transform` or `run`.
2. **Rows are streamed in batches.** Do not collect a whole input in memory unless it is small (`collect` / `count` exist for that). `from(source).map(...).filter(...).to(sink)` keeps memory flat.
3. **Writes are all or nothing as far as the adapter can make them**: a database sink is one transaction (rolled back when the pipe fails), a CSV sink writes a temp file and moves it into place at the end. Do not catch an error just to continue; let it fail so nothing half-written is kept.
4. **SQL only through the `sql` tagged template.** Every `${value}` is a bound parameter. `sql.id(name)` for a table or column chosen at run time, only from a fixed list (a param with `choices`). `sql.raw` is only for fixed text written here. A db source may only read.
5. **No connection details or secrets in the code**: no hosts, users, passwords or DSNs. The connection name (`{{connection}}`) is the only link to the database.
6. **The schema and the files come from the user.** You have no database tools and must not try to connect: ask for the table definitions and for a sample of each CSV, and for what each pipe should do. Do not guess column names.
7. **Params**: a camelCase name is a kebab flag (`minCents` is `--min-cents`); `type` is `string` (default), `number` or `boolean`; `required`, `default`, `help` and `choices` as needed. Params reach `inputs`, `outputs`, `transform` and `run`.
8. **CSV values are text.** A CSV source gives every cell as a string (empty cell: empty string); convert in `transform` (`Number`, dates) on purpose. Money and big numbers stay strings or are converted deliberately, never through floating point.
9. **No third-party runtime dependencies.** The `@pulpfixer/*` packages are the only ones.

## Testing

- Logic: run the pipe body on `memorySource([...])` and `memorySink(out)` with `runPipe` (see `tests/pipes.test.ts`), or test `transform` as a plain function.
- SQL: register the fake driver, run `pf {{name}} <pipe> --yes` through `plugin.commands[0].run(...)` and check the statements sent (`log[i]`).
- Files: write a CSV into a temp folder, run the pipe, read the result back.
- Check `--dry-run` writes nothing.

Run `pnpm test` and `pnpm typecheck` (or `pf test`, `pf_run test`).

## Versions and publishing

- After a change, bump the version with `pf ver` (it lists the ready-to-run bump commands; `pf_bump` from the agent): `minor`, or `major` when a pipe is renamed or removed or its flags change incompatibly. Never edit the version by hand.
- Publishing goes to cellars as `@pulpfixer/pipe-{{name}}`: `pf ps` (runs `publish:cellars`: typecheck, test, `pnpm publish`). It always asks first. **Publish only when the user asks.**
- Cellars treats `@pulpfixer/pipe-` as a **clearance** prefix: the package is created restricted on its first publish, so only users with the clearance role can see or install it (`pf plugin install pipe-{{name}}`); others get a 404. A cellars administrator must have marked the prefix before the first publish.
