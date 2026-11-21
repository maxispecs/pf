# pulpfixer

```text
         ⢀⣤⣤⣀⡀ ⣠
         ⣦⡙⠿⠿⠿⣿⣿⣇
         ⣿⣿⣿⣿⣿⣿⣿⣿⣆
      ⠠⠶⡆⠉⠉⣉⣉⣉⣩⣭⣿⣿⣷⠶
        ⠛⠈⠉⠙⣿⡿⠋⣿⣿⡇          p u l p f i x e r
         ⢀   ⢀⣀⣽⡏           the wolf of dev street
        ⢀⣌⠢⢄  ⠘⣿⠁           ░▒▓███████████████████████████████▓▒░
      ⣀⣴⣿⣿⡕⢄⠈⢻⣿⣷⣄           pf :: third edition
  ⣀⣤⣶⣿⣟⣿⣿⣿⣿⣿⢦⣀⡿⢹⣿⣷⣦⣄⣀
⠒⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡌⢫⡇ ⣿⣿⣿⣷⣽⡷
   ⠉⠻⢿⣿⣿⣿⣿⣿⣿⣿⡄⠡ ⢻⣿⣿⣿⠇
      ⠙⢿⣿⣿⣿⣿⣿⣷⡀⢣⠸⣿⣿⡏
       ⠈⠻⣿⡿⠋⠉   ⠁⢿⡿
         ⠉        ⠃
```

## Install

```bash
[ -w "$(npm root -g)" ] || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH" && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.$(basename "$SHELL")rc; }; npm install -g pulpfixer --registry https://cellars.staging.pangenea.com/ && pf setup --yes && pf skill install --all && pf suite enable --yes
```

That installs pf, sets the machine up, installs the agent skills and applies the pulpfixer suite to Cursor (the standard extensions and settings, and Background Tone).

### Just pf, without the skills and the suite:

```bash
[ -w "$(npm root -g)" ] || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH" && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.$(basename "$SHELL")rc; }; npm install -g pulpfixer --registry https://cellars.staging.pangenea.com/ && pf setup
```

#### Add-ons

```bash
pf skill install --all    # agent skills
pf sys apply              # install pulpfixer suite
```

Needs Node >= 18 and npm, no token: pf and its packages are public on the cellars registry. The first part only runs when npm's global directory is not writable (Homebrew Node: `EACCES`): it switches npm to a user-owned prefix, `~/.npm-global`, so no `sudo` is needed. `--registry` applies to this install only. Then run `pf` in any repo; `pf update` keeps it current. More options (from source, plugins, dry run) are in [Getting started](packages/docs/content/getting-started.mdx).

Afterwards, `pf doctor` checks the machine and `pf rp` (in a repo) hooks pf's helpers in. `pf update` keeps pf, its plugins, skills and installed suite extensions current. Details are in [After installing](packages/docs/content/getting-started.mdx#after-installing).

## This repo

`pf` is a developer CLI for any repo, in any language. This repo is a pnpm workspace; the docs site is [packages/docs](packages/docs) (Nextra, run it with `pf docs` or `pnpm docs:dev`), and the user-facing reference is also in [packages/pulpfixer/README.md](packages/pulpfixer/README.md). The agent (tools, project profiles, scoped AWS access, writing agent tools in a plugin) is documented in [packages/pulpfixer/docs/agent.md](packages/pulpfixer/docs/agent.md).

| Package | Name | What |
|---------|------|------|
| `packages/kit` | `@pulpfixer/kit` | shared foundation: repo/stack detection, exec, ui, config, `Command`/`Plugin` types |
| `packages/plugin-aws` | `@pulpfixer/plugin-aws` | AWS plugin (`pf s3`, `pf dl`, `pf aws`, the agent's `pf_aws_*` tools) |
| `packages/plugin-yubikey` | `@pulpfixer/plugin-yubikey` | YubiKey plugin (`pf otp`, `pf yk`) |
| `packages/plugin-db` | `@pulpfixer/plugin-db` | database plugin (`pf db`, query helpers, the `db` IO adapter, the built-in SQLite driver); drivers `packages/db-postgres`, `db-mysql`, `db-dynamodb` are separate plugins |
| `packages/plugin-io` | `@pulpfixer/plugin-io` | IO plugin (`pf io`): IO adapters and pipes (`@pulpfixer/pipe-<name>` packages, `definePipes`, the chain helpers) |
| `packages/plugin-csv` | `@pulpfixer/plugin-csv` | CSV plugin (`pf csv`, the `csv` IO adapter) |
| `packages/plugin-pdf` | `@pulpfixer/plugin-pdf` | PDF plugin (`pf pdf`, the `pdf` IO adapter: extract text and data, write PDFs from layout templates) |
| `packages/pulpfixer` | `pulpfixer` | the `pf` binary: dispatch, built-in commands, agent, host mode, skills |
| `packages/docs` | `@pulpfixer/docs` | the documentation site (Nextra); private, never published |

Root commands (`pnpm ask` lists them): `pnpm dev -- <args>`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm ver`, `pnpm docs:dev`, `pnpm docs:build`, `pnpm install:local`, `pnpm release`, `pnpm publish:cellars`.
