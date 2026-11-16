# pulpfixer monorepo

`pf` is a developer CLI for any repo, in any language. This repo is a pnpm workspace; the docs site is [packages/docs](packages/docs) (Nextra, run it with `pf docs` or `pnpm docs:dev`), and the user-facing reference is also in [packages/pulpfixer/README.md](packages/pulpfixer/README.md). The agent (tools, project profiles, scoped AWS access, writing agent tools in a plugin) is documented in [packages/pulpfixer/docs/agent.md](packages/pulpfixer/docs/agent.md).

| Package | Name | What |
|---------|------|------|
| `packages/kit` | `@pulpfixer/kit` | shared foundation: repo/stack detection, exec, ui, config, `Command`/`Plugin` types |
| `packages/plugin-aws` | `@pulpfixer/plugin-aws` | AWS plugin (`pf s3`, `pf dl`, `pf aws`, the agent's `pf_aws_*` tools) |
| `packages/plugin-yubikey` | `@pulpfixer/plugin-yubikey` | YubiKey plugin (`pf otp`, `pf yk`) |
| `packages/pulpfixer` | `pulpfixer` | the `pf` binary: dispatch, built-in commands, agent, host mode, skills |
| `packages/docs` | `@pulpfixer/docs` | the documentation site (Nextra); private, never published |

Root commands (`pnpm ask` lists them): `pnpm dev -- <args>`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm ver`, `pnpm docs:dev`, `pnpm docs:build`, `pnpm install:local`, `pnpm release`, `pnpm publish:cellars`.
