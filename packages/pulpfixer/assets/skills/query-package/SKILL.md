---
name: query-package
description: Create or fill in a pf query package (@pulpfixer/query-<name>), named SQL queries on one pf db connection published to cellars. Use when the user wants a new query package, wants to add or change queries in one, or asks how to publish one.
---

# Query package

A query package turns named SQL queries into the command `pf <name> <query>`. It holds the queries and their post-processing only; connections and credentials stay in `pf db`.

## No package yet

Ask the user for the package name (lowercase, dashes), the pf db connection it uses and the database (postgres, mysql or sqlite). Then ask them to run (from any folder; the repo goes in the suite's repos folder, `~/dev` unless `pf suite config` says otherwise, or in `--dir <path>`):

```bash
pf template apply query-package <name> --connection <connection> --driver <driver>
```

It creates `<repos folder>/query-<name>/` with the source, tests, `AGENTS.md` and pf's repo setup (link, pnpm commands, versioning). It prints the folder (`cd <path>` under "Next:"); continue inside that folder, not in the current one.

## Filling it in

1. Read `AGENTS.md` in the repo: it has the rules (bound parameters through `sql`, `writes: true` for anything that changes data, no connection details or secrets in the code). Call `pf_commands` for the repo's commands.
2. Ask the user for the schema: DDL, a migrations folder or a description of the tables and columns. You have no database tools; never try to connect, and do not guess column names.
3. Ask what each query should answer and which inputs it takes. Turn the inputs into `params` (types, `required`, `default`, `choices`, `help`).
4. Write each query in `src/` with the `sql` tagged template. Keep read queries read-only; mark a writing one `writes: true` and say so to the user.
5. Add a test per query in `tests/`: the fake driver answers with rows shaped like the real table; check the SQL text and values sent and the output.
6. Run `install` (first time), `typecheck`, `test` and `build` with `pf_run`. Fix failures before going on.
7. Remove the `ping` example once real queries exist (and its test).
8. Call `pf_bump` with `minor` (`major` when a query was renamed or removed, or its flags changed incompatibly).

## Publishing

Publishing is the user's step: ask them to run `pf ps` (it typechecks, tests and publishes `@pulpfixer/query-<name>` to cellars, and asks first). Do not publish unasked. The `@pulpfixer/query-` prefix is a clearance prefix on cellars: only users with the clearance role can install the package (`pf plugin install query-<name>`), and a cellars administrator must have marked the prefix before the first publish.

Leave `.npmrc` as it is (its auth line is `${NPM_TOKEN}`) and never read, print or write a token.
