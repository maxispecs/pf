# pf

One command line for every repo, in any language. Run `pf` in a repo to get its menu; run it anywhere else to get a fallback menu (run a skill, about, doctor).

```
pf              menu for this repo
pf dev          run the app locally (any language)
pf ver          versions and bumps (the /ver skill)
```

Every invocation prints its version (`pf v2.0`) on stderr.

## Install

From the cellars registry (needs `NPM_TOKEN`, token from #frontend):

```bash
npm install -g pulpfixer --registry https://cellars.staging.pangenea.com/
pf setup
```

Or on a machine that has nothing yet, from a checkout of this repo:

```bash
scripts/install.sh                # latest published version
scripts/install.sh --from-source  # build this checkout and link it globally
scripts/install.sh --dry-run      # show what would happen
```

`pf` replaces the legacy `pulpfixer` 1.x package. The installer and `pf setup` remove the old global install (its data in `~/.pulpfixer` is left alone). Update with `pf update`; remove with `pf uninstall`. `pf doctor` checks the machine.

## Commands

| Command | What it does |
|---------|--------------|
| `pf` | Menu: this repo's commands, or the fallback menu outside a repo. Includes the agent |
| `pf agent [prompt]` | Open the coding agent (Claude Code, Codex or Cursor) with pf's tools and skills. `--agent`, `--dry-run`. `pf agent use [id]` sets the default |
| `pf list` | The same list, static (for scripts and agents) |
| `pf dev`, `build`, `test`, `lint`, `install` | Resolved per repo, see below. `--dry-run` prints, `--pick` chooses when several exist, `-- <args>` passes args on |
| `pf ver [list\|bump\|init\|sync]` | Major.minor versioning with the bundled `/ver` CLI |
| `pf doc` | Run the docs site (Nextra, Docusaurus, VitePress, Starlight, mkdocs, Sphinx, mdBook, Hugo) |
| `pf deploy staging` | Deploy to staging. `--dry-run`, `--yes`. Never production |
| `pf skill [name]` | Pick and run an agent skill. `available`, `install`, `update`, `remove` manage skills from the registry |
| `pf init` | Write `pf.json` for this repo from what was detected |
| `pf setup`, `update`, `uninstall`, `doctor` | Machine tooling |
| `pf about`, `pf help`, `pf --version` | Info |

### How commands are resolved

For `dev`, `build`, `test`, `lint` and `install`, in order:

1. `pf.json` `commands.<name>`
2. A script or target the repo already has: `package.json` scripts, `composer.json` scripts, Makefile and justfile targets
3. A stack default: Node (pnpm, npm, yarn, bun), Python (uv, poetry, pipenv, pip), Go, Rust, Java (Maven, Gradle), .NET, Ruby, PHP, Elixir, Swift, Docker Compose

### pf.json

```json
{
  "name": "my-service",
  "commands": {
    "dev": { "run": "uv run fastapi dev", "description": "Run the API", "group": "Develop" },
    "seed": { "run": "./scripts/seed.sh", "description": "Load sample data", "group": "Tools", "cwd": "." }
  }
}
```

Built-in names (`dev`, `build`, ...) override detection. Other names show up in the menu and run with `pf seed`. `deploy:staging` and `doc` override those commands. `pf init` writes a starting file.

### Skills

`pf skill` finds skills in `~/.cursor/skills`, `~/.cursor/skills-cursor`, `~/.agents/skills`, `~/.claude/skills`, the repo's `.cursor/skills`, `.agents/skills`, `.claude/skills`, pf's own folder `~/.pf/skills`, and the skills bundled with pf, in that order: a skill in an earlier directory wins over a later one with the same name. Skills in `~/.pf/skills` and the bundled ones run through `pf agent`, which reads them with the `pf_skill` tool, so they work with any agent CLI. `ver` and `pnpm` run their scripts directly. Others run through the agent CLI.

#### Skills from the registry

The skills repo publishes each skill to cellars as `@pf-skills/<name>`, or `@pf-skills-<name>/<name>` when it has its own package. pf installs and updates them:

```bash
pf skill available                  # registry skills, their versions and where they are installed
pf skill install ver bp             # latest version into pf's own folder, ~/.pf/skills
pf skill install --all --to claude  # every skill, into ~/.claude/skills instead
pf skill update [name...]           # bring registry installs to the latest (--check only reports)
pf skill remove ver                 # delete a registry install
```

`--to` takes `pf` (the default), `cursor`, `claude`, `agents` or `all` (comma-separated); use an agent folder when that agent should see the skill outside `pf agent`. An install keeps the package's `package.json` in the skill folder; that marks it as a registry install. pf never replaces a symlink (a skills repo checkout) or a folder it did not install unless you pass `--force`. `pf update` also updates every registry install. A skill named `available`, `install`, `update`, `remove` or `run` runs as `pf skill run <name>`.

### Agent

`pf agent` (also the Agent entry in the `pf` menu) starts Claude Code, Codex or Cursor with a system prompt built from this repo, the pf tools (`pf mcp`) and the skills above. The agent CLI is chosen with `--agent`, `PF_AGENT`, or `"agent"` in `~/.pf/config.json` (`claude`, `codex` or `cursor`; `claude-code` and `cursor-agent` are accepted too). Otherwise the first installed CLI is used, and a terminal asks the first time more than one is installed. `pf agent use cursor` also registers the pf MCP server in `~/.cursor/mcp.json`.

The tools can list and run this repo's commands, bump versions and deploy to staging. A staging deploy returns the plan until the call passes `confirm`, and the agent CLI asks before running it. Production is never targeted.

## Develop

```bash
pnpm install
pnpm dev -- list          # run from source
pnpm typecheck && pnpm test && pnpm build
pnpm install:local        # build and link this checkout as the global pf
pnpm ask                  # every script
```

`./pf` in the checkout root runs the local source with no build, while the global `pf` stays as installed. It keeps your current directory, so you can point it at another repo:

```bash
./pf dev --dry-run
cd ~/some/repo && ~/dev/agents/pulpfixer/pf dev --dry-run
```

## Release

```bash
pnpm ver bump stack minor   # a published version cannot be reused
pnpm release                # typecheck, test, build, npm publish --dry-run
pnpm publish:cellars        # the real publish (asks you to type the version)
```
