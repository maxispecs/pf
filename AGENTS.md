# pf (pulpfixer v2)

`pf` is a developer CLI for any repo, in any language: one menu (`pf`) and unified commands (`pf dev`, `pf build`, `pf ver`, ...). It replaces the legacy `pulpfixer` 1.x package and owns the `pf` binary. Published to the cellars registry (`https://cellars.staging.pangenea.com/`) as `pulpfixer`.

## Monorepo

pnpm workspace, four packages (versioned together by `versions.json`, published to cellars):

- `packages/kit` (`@pulpfixer/kit`): shared foundation. detect, exec, ui, config, util, context and the `Command` / `Plugin` types. Import it by subpath (`@pulpfixer/kit/ui/text`). Depends on nothing.
- `packages/plugin-aws` (`@pulpfixer/plugin-aws`): the AWS plugin. Depends only on kit.
- `packages/plugin-yubikey` (`@pulpfixer/plugin-yubikey`): the YubiKey plugin (`pf otp`, `pf yk`, wrapping `ykman`). Depends only on kit.
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
- Shortcuts: a short name for a full command (`pf r` = `pf dev`, `pf rp` = `pf repo`, `pf ds` = `pf deploy staging`, `pf dp` = `pf deploy production`, `pf ps` = `pf publish staging`, which runs a repo's `publish:cellars` script and always confirms) is one entry in `SHORTCUTS` in `packages/core/src/commands/shortcuts.ts`. Extra args pass through to the target.
- New command: add `packages/core/src/commands/<name>.ts`, register it in `packages/core/src/commands/index.ts`, show it in `packages/core/src/menu.ts` if it belongs in the menu, add a test.
- Command resolution order is `pf.json` override, then scripts/targets the repo defines, then stack defaults (`packages/kit/src/detect/`). New stacks go in `packages/kit/src/detect/stacks.ts` with a test in `packages/kit/tests/`.
- PHP (`composer.json`): `dev`/`build`/`test`/`lint` come from composer scripts (`dev serve start`, `test tests phpunit`, `lint cs-check cs phpcs stan phpstan analyse`), else framework and tool defaults (Laravel `artisan`, CakePHP `bin/cake server`, built-in server on `public`/`webroot`; Pest, PHPUnit, Pint, PHP CS Fixer, PHP_CodeSniffer, PHPStan from `vendor/bin`). `pf deploy staging|production` also run a composer script named like the node ones (`deploy:staging`, ...).
- Local repo CLI (`a` + `cli/run` + `cli/commands/**/*.sh`, `# desc:` / `# usage:` headers): `packages/kit/src/detect/localcli.ts`. A command named like a task (`dev`, `build`, `test`, `lint`, `install`/`setup`) is that task's repo script, `deploy:staging` / `deploy:production` are deploy targets (`-y` is added when its usage mentions it, pf already confirmed), and `pf tools [name] [args]` (`core/src/commands/tools.ts`) lists and runs the rest.

## Layout

| Path (under `packages/` unless root) | What |
|------|------|
| `packages/core/src/bin/pf.ts`, `cli.ts` | entry point, banner, dispatch |
| `core/src/menu.ts` | repo menu, fallback menu, static list |
| `kit/src/detect/` | repo, stack, docs and staging detection, command resolution; `localcli.ts` reads a repo's own `./a` CLI |
| `kit/src/ui/prompt.ts` | `confirm` (yes/no) and `ask` (single-line text input with default, placeholder and `validate`). Use `ask` for any input field; it returns null without a TTY or on cancel, so give commands flags too |
| `kit/src/ui/text.ts` | text helpers: colored command samples (`termLine`, `promptLine`), badges, headings, lists, tables. Return strings, take a `Palette`. Use these instead of hand-coloring messages |
| `plugin-yubikey/src/` | YubiKey plugin (`ykman`): `ykman.ts` argv builders, clipboard and runner, `audit.ts` pure parsers and findings, `commands/otp.ts` (`pf otp`), `commands/yk.ts` (`pf yk`); never reads secrets, ykman owns the password and touch prompts, and nothing here changes the key |
| `core/src/local.ts`, `core/src/devcycle.ts` | the `./pf` checkout menu; its `cycle` entry (`./pf cycle [--message m] [--yes] [--dry-run]`) is the dev cycle: bump changed packages (`planBumps`, core goes along), commit, `pnpm run publish:cellars`, then `pf u --yes` so the global pf updates itself |
| `core/src/commands/` | built-in commands |
| `core/src/agent/` | coding agent: persona, tool registry, MCP server, launchers for claude, codex and cursor |
| `core/src/host/` | host mode (`pf host`): host config, IMDS identity and secrets via the aws CLI, SSM send-command, OS security patching, host MCP tools, the headless fix agent and its audit log |
| `kit/src/plugin.ts`, `plugin-settings.ts`, `core/src/plugins/index.ts` | plugin API, saved plugin settings, and the registry of built-in plugins |
| `plugin-aws/src/` | AWS plugin (exchange bucket: `pf s3`, `pf dl`); add AWS shortcuts under `commands/` |
| `core/src/skills/` | skill discovery and runner (direct scripts, else an agent CLI) |
| `core/assets/skills/` | skills that ship with pf (a same-named user or repo skill wins) |
| `core/src/install/`, `core/src/update/` | machine setup helpers, update check |
| `core/assets/version.mjs`, `core/assets/tasks.mjs` | bundled copies of the `/ver` CLI and the `/pnpm` helper (same files as `scripts/version.mjs`, `scripts/tasks.mjs`), the offline fallback. Refresh them with `pnpm skills:sync`, never rewrite them. `pf update` keeps the `ver` and `pnpm` skills (`STACK_SKILLS` in `core/src/skills/stack.ts`) current in `~/.pf/skills` and refreshes a repo's copies from the newest of that and the bundled file (`resolveVerCli`, `resolveTasksHelper`); run helpers through those, not `bundledVerCli()` |
| `core/src/commands/repo.ts` | `pf repo` / `pf rp`: installs or updates those helpers in a repo (pnpm root commands, versioning) and wires its `package.json`; rerun after `pf update` |
| `core/scripts/install.sh` | install on a machine without pf (`--from-source` for a checkout) |
| `scripts/logo-art.mjs` | turns `core/assets/pulpfixer.png` into the header art in `kit/src/ui/logo-art.ts` (generated, commit the output) |
| `core/assets/art/`, `core/src/art/` | art assets: `art.json` maps a command to a picture (a built-in octopus, a `name.ansi` file here or in `~/.pf/art/`, or `none`); `cli.ts` prints it to stderr before the command runs; `lost` stays built in; see `assets/art/README.md`, `pf art` lists them |
| `kit/src/ui/mascot.ts` | original pixel-art octopus (sprites defined in the file, drawn at runtime) printed to stderr by `pf repo`, `pf update` and `pf agent`; TTY only, `PF_NO_MASCOT=1` (or `PF_NO_TRAVOLTA=1`) turns it off; Apple Terminal gets the flat version |
| `scripts/travolta-art.mjs`, `kit/src/ui/lost.ts` | confused Travolta (`scripts/art/travolta.png`, a frame of the cutout GIF -> `kit/src/ui/travolta-art.ts`, generated; half blocks in true color or 256 colors, braille without color) printed on an unknown command or an uncaught error, TTY only, `PF_NO_TRAVOLTA=1` turns it off |
| `scripts/gif-art.mjs`, `gif.mjs` | terminal viewer for a GIF as color art, sized to the terminal, background cut off (arrows move between frames, enter saves the frame as a JS module with ANSI colors); `gif.mjs` is the shared GIF decoder and PNG encoder |
| `scripts/gif-frame.mjs` | pulls one frame (middle by default) out of a GIF as a PNG with transparency, optional `--crop`; source pictures for art generators like `travolta-art.mjs` (no dependencies) |
| `scripts/build.mjs`, `test.mjs` | build / test every package |
| `scripts/release.mjs` | check, build, dry-run publish of every unpublished package (`--publish` for real) |

## Commands

`pnpm ask` lists every script. Common ones: `pnpm dev -- <args>` (run from source), `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm install:local`, `pnpm release`.

## Versioning

When a change is made in a module (package), bump that module's minor version before finishing:
`pnpm ver bump <module> minor`. This also bumps the stack minor. Use `major` only for breaking changes.
Never edit versions in manifests by hand. Modules are the packages: `pnpm ver bump packages/core minor`, `pnpm ver bump packages/kit minor`, `pnpm ver bump packages/plugin-aws minor`, `pnpm ver bump packages/plugin-yubikey minor` (several targets may share one command; the stack minor rises once). Bump a package only when its own files changed; a core change that depends on a new kit change bumps both.

Publishing: `pnpm release` is always a dry run and publishes every package whose version the registry lacks, in dependency order. `pnpm publish:cellars` publishes without a confirmation prompt. Never publish without the user asking.
