# pulpfixer monorepo

`pf` is a developer CLI for any repo, in any language. This repo is a pnpm workspace; the user-facing docs live in [packages/core/README.md](packages/core/README.md).

| Package | Name | What |
|---------|------|------|
| `packages/kit` | `@pulpfixer/kit` | shared foundation: repo/stack detection, exec, ui, config, `Command`/`Plugin` types |
| `packages/plugin-aws` | `@pulpfixer/plugin-aws` | AWS plugin (`pf s3`, `pf dl`) |
| `packages/core` | `pulpfixer` | the `pf` binary: dispatch, built-in commands, agent, host mode, skills |

Root commands (`pnpm ask` lists them): `pnpm dev -- <args>`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm ver`, `pnpm install:local`, `pnpm release`, `pnpm publish:cellars`.
