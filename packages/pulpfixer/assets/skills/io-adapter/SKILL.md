---
name: io-adapter
description: Create or fill in a pf IO adapter add-on (@pulpfixer/io-<name>), a new kind of input and output for pf pipes (an API, a queue, a file format, a bucket), published to cellars. Use when the user wants pipes to read from or write to something pf cannot yet, or asks how to write or publish an IO adapter.
---

# IO adapter

An IO adapter teaches pf pipes one more kind of input and / or output. pf ships `db` (a pf db connection), `csv`, `memory` and `stdout`; anything else is an add-on package `@pulpfixer/io-<name>` that registers its adapter when pf loads it (`pf plugin install io-<name>`, `pf io adapters` lists it). Adapter add-ons are open (no clearance), so write nothing in them that should stay private.

## No package yet

Ask the user for the adapter name (lowercase letter first, then letters, digits, dashes), a one-line summary, and what it talks to. Then ask them to run, in the folder that should hold the new repo:

```bash
pf template apply io-adapter <name>
```

It creates `io-<name>/` with a working sample (JSON Lines files), tests, `AGENTS.md` and pf's repo setup. Continue inside that folder.

## Filling it in

1. Read `AGENTS.md` in the repo: it has the rules (stream in batches, nothing visible before `close(true)`, discard on `close(false)`, dry run changes nothing, `describe` shows no secrets, no third-party runtime dependencies). Call `pf_commands` for the repo's commands.
2. Ask the user what the backend is, how it authenticates, how it pages or accepts bulk writes, and what a row looks like. Credentials are never in the code or the config of a pipe: take a name or reference and resolve it at run time.
3. Replace the sample in `src/adapter.ts`: the `Config` type, `describe`, `source` (an async iterable of row batches), `sink` (`write(batch)` then `close(ok)`), and the `source(config)` / `sink(config)` builders pipes import.
4. Keep `harmless` off unless writing changes nothing outside the process.
5. Tests in `tests/`: keep the contract test (`validateIoAdapter`), the round trip, the failed-pipe and dry-run cases, and add the backend's own cases against a fake of the service, never the real one.
6. Run `install` (first time), `typecheck`, `test` and `build` with `pf_run`. Fix failures before going on.
7. Call `pf_bump` with `minor` (`major` when the config shape changes incompatibly).

## Publishing

Publishing is the user's step: ask them to run `pf ps` (it typechecks, tests and publishes `@pulpfixer/io-<name>` to cellars, and asks first). Do not publish unasked.

Leave `.npmrc` as it is (its auth line is `${NPM_TOKEN}`) and never read, print or write a token.
