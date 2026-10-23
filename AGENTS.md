# pf (pulpfixer v2)

`pf` is a developer CLI for any repo, in any language: one menu (`pf`) and unified commands (`pf dev`, `pf build`, `pf ver`, ...). It replaces the legacy `pulpfixer` 1.x package and owns the `pf` binary. Published to the cellars registry (`https://cellars.staging.pangenea.com/`) as `pulpfixer`.

## Monorepo

pnpm workspace, three packages (versioned together by `versions.json`, published to cellars):

- `packages/kit` (`@pulpfixer/kit`): shared foundation. detect, exec, ui, config, util, context and the `Command` / `Plugin` types. Import it by subpath (`@pulpfixer/kit/ui/text`). Depends on nothing.
- `packages/plugin-aws` (`@pulpfixer/plugin-aws`): the AWS plugin. Depends only on kit.
- `packages/core` (`pulpfixer`): the `pf` binary, built-in commands, agent, host mode, skills, install and update. Depends on kit and every plugin.

Dependencies point one way: core -> plugins -> kit. A plugin never imports core. Anything a plugin needs from core moves into kit.
Each package exports `source` / `types` / `default` conditions: dev, tests and typecheck run with `--conditions=source` (straight from `src/`), builds and installs use `dist/`. Root `scripts/` hold the cross-package commands (build, test, release, ver, logo, ask).
Registry plugins (user-installed): `@pf-plugins/<name>` packages live in the npm prefix `~/.pf/plugins` (its `package.json` is the remembered list). `packages/core/src/plugins/registry.ts` (npm ops, names), `loader.ts` (import at startup in `main()`, failures never stop pf), `manage.ts` (list/install/update/remove, reused by `pf update`) and `commands/plugin.ts`. Plugin commands are appended after every built-in and de-duplicated, so a plugin never shadows a built-in. Core pins kit and the built-in plugins to exact versions and users only update `pulpfixer`, so the release script refuses to publish a dependency without a new core.
New built-in plugin: `packages/plugin-<name>` (copy `plugin-aws`'s package.json and tsconfig), add it to `scripts/build.mjs`, `scripts/release.mjs` (`ORDER`), the `core` dependencies and `packages/core/src/plugins/index.ts`, then `pnpm ver init`.

## Conventions

- TypeScript, ESM, strict. Node >= 18. **No third-party runtime dependencies**: colors, the picker and argument parsing are hand-written. Dev dependencies only (`typescript`, `tsx`, `@types/node`); the packages depend on each other through `workspace:*`.
- Every invocation prints a banner with the version (`pf v2.0`) to **stderr**, so stdout stays pipeable. Do not add output paths that skip it.
- Colors follow `NO_COLOR` / `FORCE_COLOR` (`src/ui/palette.ts`). Anything with a terminal-only mode (the menu, prompts) must fall back to static output without a TTY.
- Never read, print or write a registry token. Only check that an auth line exists. `.npmrc` uses `${NPM_TOKEN}`. The one exception is host mode, which reads secrets with the instance role into a child process's env only, never to disk or output.
- Host mode (`pf host fix`) gives the agent no shell or file tools. Anything that changes the host is a pf host tool, and the MCP server refuses it without `--apply`.
- Commands that run something support `--dry-run`. `pf deploy staging` auto-detects its target. `pf deploy production` runs only a `deploy:production` script or `pf.json` entry the repo defines (never guessed from platform configs), always asks for confirmation, and needs `--yes` without a TTY. The agent and MCP tools deploy to staging only.
- Shortcuts: a short name for a full command (`pf ds` = `pf deploy staging`, `pf dp` = `pf deploy production`) is one entry in `SHORTCUTS` in `packages/core/src/commands/shortcuts.ts`. Extra args pass through to the target.
- New command: add `packages/core/src/commands/<name>.ts`, register it in `packages/core/src/commands/index.ts`, show it in `packages/core/src/menu.ts` if it belongs in the menu, add a test.
- Command resolution order is `pf.json` override, then scripts/targets the repo defines, then stack defaults (`packages/kit/src/detect/`). New stacks go in `packages/kit/src/detect/stacks.ts` with a test in `packages/kit/tests/`.

## Layout

| Path (under `packages/` unless root) | What |
|------|------|
| `packages/core/src/bin/pf.ts`, `cli.ts` | entry point, banner, dispatch |
| `core/src/menu.ts` | repo menu, fallback menu, static list |
| `kit/src/detect/` | repo, stack, docs and staging detection, command resolution |
| `kit/src/ui/prompt.ts` | `confirm` (yes/no) and `ask` (single-line text input with default, placeholder and `validate`). Use `ask` for any input field; it returns null without a TTY or on cancel, so give commands flags too |
| `kit/src/ui/text.ts` | text helpers: colored command samples (`termLine`, `promptLine`), badges, headings, lists, tables. Return strings, take a `Palette`. Use these instead of hand-coloring messages |
| `core/src/commands/` | built-in commands |
| `core/src/agent/` | coding agent: persona, tool registry, MCP server, launchers for claude, codex and cursor |
| `core/src/host/` | host mode (`pf host`): host config, IMDS identity and secrets via the aws CLI, SSM send-command, OS security patching, host MCP tools, the headless fix agent and its audit log |
| `kit/src/plugin.ts`, `plugin-settings.ts`, `core/src/plugins/index.ts` | plugin API, saved plugin settings, and the registry of built-in plugins |
| `plugin-aws/src/` | AWS plugin (exchange bucket: `pf s3`, `pf dl`); add AWS shortcuts under `commands/` |
| `core/src/skills/` | skill discovery and runner (direct scripts, else an agent CLI) |
| `core/assets/skills/` | skills that ship with pf (a same-named user or repo skill wins) |
| `core/src/install/`, `core/src/update/` | machine setup helpers, update check |
| `core/assets/version.mjs`, `core/assets/tasks.mjs` | bundled copies of the `/ver` CLI and the `/pnpm` helper (same files as `scripts/version.mjs`, `scripts/tasks.mjs`). Refresh them with `pnpm skills:sync`, never rewrite them |
| `core/src/commands/repo.ts` | `pf repo` / `pf r`: installs or updates those helpers in a repo (pnpm root commands, versioning) and wires its `package.json`; rerun after `pf update` |
| `core/scripts/install.sh` | install on a machine without pf (`--from-source` for a checkout) |
| `scripts/logo-art.mjs` | turns `core/assets/pulpfixer.png` into the header art in `kit/src/ui/logo-art.ts` (generated, commit the output) |
| `scripts/travolta-art.mjs`, `kit/src/ui/lost.ts` | confused Travolta (`scripts/art/travolta.png`, a frame of the cutout GIF -> `kit/src/ui/travolta-art.ts`, generated; quadrant blocks in true color or 256 colors, braille without color) printed on an unknown command or an uncaught error, TTY only, `PF_NO_TRAVOLTA=1` turns it off |
| `scripts/build.mjs`, `test.mjs` | build / test every package |
| `scripts/release.mjs` | check, build, dry-run publish of every unpublished package (`--publish` for real) |

## Commands

`pnpm ask` lists every script. Common ones: `pnpm dev -- <args>` (run from source), `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm install:local`, `pnpm release`.

## Versioning

When a change is made in a module (package), bump that module's minor version before finishing:
`pnpm ver bump <module> minor`. This also bumps the stack minor. Use `major` only for breaking changes.
Never edit versions in manifests by hand. Modules are the packages: `pnpm ver bump packages/core minor`, `pnpm ver bump packages/kit minor`, `pnpm ver bump packages/plugin-aws minor` (several targets may share one command; the stack minor rises once). Bump a package only when its own files changed; a core change that depends on a new kit change bumps both.

Publishing: `pnpm release` is always a dry run and publishes every package whose version the registry lacks, in dependency order. `pnpm publish:cellars` publishes without a confirmation prompt. Never publish without the user asking.
