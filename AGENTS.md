# pf (pulpfixer v2)

`pf` is a developer CLI for any repo, in any language: one menu (`pf`) and unified commands (`pf dev`, `pf build`, `pf ver`, ...). It replaces the legacy `pulpfixer` 1.x package and owns the `pf` binary. Published to the cellars registry (`https://cellars.staging.pangenea.com/`) as `pulpfixer`.

## Conventions

- TypeScript, ESM, strict. Node >= 18. **No runtime dependencies**: colors, the picker and argument parsing are hand-written. Dev dependencies only (`typescript`, `tsx`, `@types/node`).
- Every invocation prints a banner with the version (`pf v2.0`) to **stderr**, so stdout stays pipeable. Do not add output paths that skip it.
- Colors follow `NO_COLOR` / `FORCE_COLOR` (`src/ui/palette.ts`). Anything with a terminal-only mode (the menu, prompts) must fall back to static output without a TTY.
- Never read, print or write a registry token. Only check that an auth line exists. `.npmrc` uses `${NPM_TOKEN}`.
- Commands that run something support `--dry-run`. Deploys target staging only and never production.
- New command: add `src/commands/<name>.ts`, register it in `src/commands/index.ts`, show it in `src/menu.ts` if it belongs in the menu, add a test.
- Command resolution order is `pf.json` override, then scripts/targets the repo defines, then stack defaults (`src/detect/`). New stacks go in `src/detect/stacks.ts` with a test in `tests/`.

## Layout

| Path | What |
|------|------|
| `src/bin/pf.ts`, `src/cli.ts` | entry point, banner, dispatch |
| `src/menu.ts` | repo menu, fallback menu, static list |
| `src/detect/` | repo, stack, docs and staging detection, command resolution |
| `src/ui/text.ts` | text helpers: colored command samples (`termLine`, `promptLine`), badges, headings, lists, tables. Return strings, take a `Palette`. Use these instead of hand-coloring messages |
| `src/commands/` | built-in commands |
| `src/skills/` | skill discovery and runner (direct scripts, else an agent CLI) |
| `src/install/`, `src/update/` | machine setup helpers, update check |
| `assets/version.mjs` | bundled copy of the `/ver` CLI. Copy it from the skill, do not rewrite it |
| `scripts/install.sh` | install on a machine without pf (`--from-source` for a checkout) |
| `scripts/logo-art.mjs` | turns `assets/pulpfixer.png` into the header art in `src/ui/logo-art.ts` (generated, commit the output) |
| `scripts/release.mjs` | check, build, dry-run publish (`--publish` for real) |

## Commands

`pnpm ask` lists every script. Common ones: `pnpm dev -- <args>` (run from source), `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm install:local`, `pnpm release`.

## Versioning

When a change is made in a module (package), bump that module's minor version before finishing:
`pnpm ver bump <module> minor`. This also bumps the stack minor. Use `major` only for breaking changes.
Never edit versions in manifests by hand. Here the repo is one package, so the module is the stack: `pnpm ver bump stack minor`.

Publishing: `pnpm release` is always a dry run. `pnpm publish:cellars` publishes and asks for confirmation. Never publish without the user asking.
