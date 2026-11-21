---
name: pipe-package
description: Create or fill in a pf pipe package (@pulpfixer/pipe-<name>), scripted IO that reads rows from inputs (a database through a pf db connection, CSV files, other IO adapters) and writes them to outputs, published to cellars. Use when the user wants a new pipe package, wants to add or change pipes in one, or asks how to publish one.
---

# Pipe package

A pipe package turns scripted IO into the command `pf <name> <pipe>`. A pipe declares its inputs and outputs and the code couples them. It holds that code only; connections and credentials stay in `pf db`, and the kinds of input and output come from IO adapters (`pf io adapters` lists them: `db`, `csv`, `memory`, `stdout` and any `@pulpfixer/io-<name>` installed).

## No package yet

Ask the user for the package name (lowercase, dashes), the pf db connection it uses (when a database is one end) and the kind of input and output of the first pipe (db or csv). Then ask them to run, in the folder that should hold the new repo:

```bash
pf template apply pipe-package <name> --input <db|csv> --output <csv|db> --connection <connection>
```

It creates `pipe-<name>/` with the source, tests, `AGENTS.md` and pf's repo setup (link, pnpm commands, versioning). Continue inside that folder.

## Filling it in

1. Read `AGENTS.md` in the repo: it has the rules (declare every input and output, stream in batches, SQL only through `sql`, no connection details or secrets in the code). Call `pf_commands` for the repo's commands.
2. Ask the user for the schema (DDL, a migrations folder or a description of the tables and columns) and for a sample of each CSV file (header and a few rows). You have no database tools; never try to connect, and do not guess column names.
3. Ask what each pipe should do: where rows come from, what changes on the way, where they go, and which values vary per run. Turn the varying values into `params` (types, `required`, `default`, `choices`, `help`).
4. Write each pipe in `src/`. Start from `transform` (input -> change a row -> every output). Use `run` with `from(inputs.x).filter(...).map(...).to(outputs.y)` only when the coupling needs it (several inputs, splitting rows between outputs). CSV cells arrive as text: convert on purpose.
5. Say clearly to the user which pipes write where: a database output is one transaction, a CSV output is created whole at the end.
6. Add tests in `tests/`: logic on `memorySource` / `memorySink` through `runPipe`, SQL with the fake driver, CSV through temp files; check `--dry-run` writes nothing.
7. Run `install` (first time), `typecheck`, `test` and `build` with `pf_run`. Fix failures before going on.
8. Remove the sample `copy` pipe once real pipes exist (and its tests).
9. Call `pf_bump` with `minor` (`major` when a pipe was renamed or removed, or its flags changed incompatibly).

Never run a pipe that writes to a real database or file yourself; the user runs it (`pf <name> <pipe> --dry-run` first).

## A kind of input or output that does not exist yet

That is an IO adapter, a separate add-on: use the `io-adapter` skill (`pf template apply io-adapter <name>`).

## Publishing

Publishing is the user's step: ask them to run `pf ps` (it typechecks, tests and publishes `@pulpfixer/pipe-<name>` to cellars, and asks first). Do not publish unasked. The `@pulpfixer/pipe-` prefix is a clearance prefix on cellars: only users with the clearance role can install the package (`pf plugin install pipe-<name>`), and a cellars administrator must have marked the prefix before the first publish.

Leave `.npmrc` as it is (its auth line is `${NPM_TOKEN}`) and never read, print or write a token.
