# @pulpfixer/io-{{name}}

An **IO adapter add-on** for pf: a plugin that teaches pf pipes a new kind of input and / or output (`{{name}}`). It holds only the adapter; pipes (`@pulpfixer/pipe-<name>`) use it by name.

- Package: `@pulpfixer/io-{{name}}`, installed with `pf plugin install io-{{name}}` (no clearance needed: adapters are open)
- It default-exports `{ name: 'io-{{name}}', api: 3, commands: [], ioAdapters: [adapter] }`; pf registers the adapter when it loads, `pf io adapters` lists it
- The contract is `@pulpfixer/kit/io` (`IoAdapter`, `IoSource`, `IoSink`, `IoContext`, `ioRef`). The guide is the "Writing an IO adapter" page of the pf docs (`pf docs`).
- The `io-adapter` skill (bundled with pf) walks through the work: `pf skill io-adapter`, or `pf_skill` from the agent.

## Layout

| Path | What |
|------|------|
| `src/adapter.ts` | the adapter (`source` and / or `sink`) and the builders pipes call (`source(config)`, `sink(config)`). The sample reads and writes JSON Lines files: replace it |
| `src/index.ts` | the plugin default export and the named exports pipe packages import |
| `tests/*.test.ts` | contract test (`validateIoAdapter`), round trip, rollback, dry run |
| `pulpfixer.json` | pf's view of the repo (keep its `id`; `pf rp` owns it) |
| `.npmrc` | cellars registry; the token comes from `${NPM_TOKEN}`. Never write a token into any file |

## Writing the adapter

An adapter is `{ id, label, describe(config), source?(config, io), sink?(config, io), harmless? }`. Give it a `source` to be read from, a `sink` to be written to, or both.

1. **Stream.** `source(...).batches()` is an async iterable of row arrays of at most `io.batchSize` rows. Never read a whole input into memory when the backend can page.
2. **Rows are plain objects** (`Record<string, unknown>`): column name to value. Convert at the edge (dates, big numbers) and document it.
3. **All or nothing.** A sink receives `write(batch)` in order and then `close(ok)`. Make nothing visible before `close(true)` when the backend allows it (temp file then rename, a transaction, a staged upload) and discard everything on `close(false)`. `close` must also release every handle, whatever `ok` is.
4. **Dry run.** When `io.dryRun` is true a sink changes nothing and reports what it would do with `io.log(...)`. Reads are fine.
5. **`describe` is one safe line** for the confirmation question (`{{name}} file /x/y`). Never put a secret, a token or a password in it, or in any `io.log` line or error message.
6. **Secrets and connections belong to the user's machine**, not to this repo: take a name or a reference in the config and resolve it at run time (environment variable, keychain through pf). No tokens, hosts or passwords in the code.
7. **`harmless: true`** only when writing changes nothing outside this process (memory, the terminal). Everything else leaves it off, so pf asks before a pipe writes.
8. **Validate the config** in `source` / `sink` and throw an `Error` with a message that says what to fix; pf shows it.
9. **No third-party runtime dependencies.** Only `@pulpfixer/kit` (the contract); everything else is Node's own modules.
10. The adapter `id` is lowercase letters, digits and dashes and unique: a later registration with the same id replaces an earlier one, so never reuse `db`, `csv`, `memory` or `stdout`.

## Testing

`tests/adapter.test.ts` shows the shape: the contract check, a round trip, a failed pipe (`close(false)` leaves nothing), a dry run. Add the cases of the real backend (paging, big batches, errors from the service, auth failing) with a fake of the service, never the real one. Run `pnpm test` and `pnpm typecheck` (or `pf test`, `pf_run test`).

## Versions and publishing

- After a change, bump the version with `pf ver` (it lists the ready-to-run bump commands; `pf_bump` from the agent): `minor`, or `major` when the config shape changes incompatibly. Never edit the version by hand.
- Publishing goes to cellars as `@pulpfixer/io-{{name}}`: `pf ps` (runs `publish:cellars`: typecheck, test, `pnpm publish`). It always asks first. **Publish only when the user asks.**
