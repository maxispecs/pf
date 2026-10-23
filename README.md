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
| `pf host ...` | pf on EC2 instances: install, login, update, security patching and the fix agent. See [Hosts](#hosts-ec2) |
| `pf s3 <file...>`, `pf dl [name]` | AWS plugin: upload to and download from a shared exchange bucket. See [AWS plugin](#aws-plugin) |
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

## AWS plugin

Plugins live in `src/plugins/<name>/` and are listed in `src/plugins/index.ts`; each one contributes commands and optional menu entries. The `aws` plugin wraps the aws CLI (it must be on PATH) and starts with a shared **exchange bucket**:

```bash
pf s3 --setup              # wizard: asks for bucket, profile, folder and region (prefilled with what is saved)
pf s3 --setup --bucket my-exchange [--profile exchange] [--prefix shared] [--region eu-west-1]   # no questions
pf s3 report.pdf            # upload to s3://my-exchange/shared/report.pdf (profile "exchange")
pf s3 a.zip b.zip           # several files; --as <name> renames a single one
pf dl                       # pick a file (newest first, arrows + enter) and download it to the current dir
pf dl report.pdf            # download by name (exact, case-insensitive, or a unique part of the name)
pf dl --list                # print the listing (also what you get when piped); -o <dir>, --force
```

Settings live in `plugins.aws.exchange` of `~/.pf/config.json`; `PF_EXCHANGE_BUCKET`, `PF_EXCHANGE_PROFILE`, `PF_EXCHANGE_PREFIX` and `PF_EXCHANGE_REGION` override them. The profile defaults to `exchange`. pf never reads credentials; the aws CLI resolves them from the profile. All commands support `--dry-run`, and `pf dl` is also in the menu. To add another AWS shortcut, put a command in `src/plugins/aws/commands/` and list it in `src/plugins/aws/index.ts`.

## Hosts (EC2)

`pf host` runs pulpfixer on deployed instances to fix things like pending security patches. Instances never hold a secret: pf reads `NPM_TOKEN` (for updates) and `ANTHROPIC_API_KEY` (for the agent) with the instance IAM role at run time, from SSM Parameter Store or Secrets Manager. It passes each one only into the environment of the process that needs it. Operators reach instances through SSM Run Command, with no SSH, so IAM decides who can invoke what.

### Install on instances

From your machine (needs the aws CLI and `ssm:SendCommand`):

```bash
pf host install --tag Env=staging --service nginx.service --timer
pf host install --instances i-0abc123,i-0def456 --secrets secretsmanager --prefix /pulpfixer
```

This sends `scripts/install.sh --host` through `AWS-RunShellScript`. On each instance it installs Node if missing, reads the registry token with the instance role, installs pf and Claude Code, writes `/etc/pulpfixer/host.json` (secret *names* only), and runs `pf host login`. In user data, or on a box you are already on, run `sudo bash install.sh --host [options]` instead.

### Commands on the instance

| Command | What it does |
|---------|--------------|
| `pf host init` | Write `/etc/pulpfixer/host.json` and `/etc/pulpfixer/npmrc` (the auth line reads `${NPM_TOKEN}`). `--secrets ssm\|secretsmanager`, `--prefix`, `--region`, `--service <unit>` (restart allowlist), `--budget <usd>`, `--timer` (daily `pf host update`) |
| `pf host login` | Check the instance identity (IMDSv2), the IAM role, that every secret is readable (values are discarded), and the agent CLI |
| `pf host status` | Instance, versions, pending security updates, reboot pending, recent agent runs |
| `pf host update --yes` | Install the pinned pf version (`version` in host.json, default `latest`), update registry skills and Claude Code |
| `pf host patch [--apply]` | List OS security updates (dnf, yum or apt). `--apply` installs them. Never reboots |
| `pf host fix [--apply] <task>` | Run the agent on this host |

### The fix agent

`pf host fix "patch the openssl advisory and restart nginx"` runs headless Claude Code with:

- **No shell and no file tools** (`--tools ""`). It can only use the pf host tools: status, security updates, package versions, unit status and logs, `pf_host_patch` and `pf_host_restart`.
- **Plan-only by default.** Without `--apply`, the agent may only call the read-only tools, and the `pf mcp --host` server also refuses the two write tools. The run ends with a report of what it would do.
- **Allowlisted restarts.** `pf_host_restart` only restarts units named with `pf host init --service`.
- **A spending cap.** `maxBudgetUsd` in host.json, default 5.
- **An audit log.** Every run writes a log to `/var/log/pulpfixer/` (root only): a header with time, instance, user, mode and task, then the full transcript and the exit code.

### From your machine

```bash
pf host send --tag Env=staging status
pf host send --tag Env=staging patch                  # list security updates on every instance
pf host send --instances i-0abc123 fix "why is nginx failing?"
pf host send --instances i-0abc123 fix --apply "install the pending security updates"
```

`send` runs only `status`, `login`, `update`, `patch` or `fix`, and quotes the arguments for the remote shell. It prints the SSM command id and the `aws ssm` commands to read each instance's output. `--aws-region` picks the region, and `--dry-run` prints the `aws ssm send-command` call.

### IAM

The instance role needs read access to the secrets, plus SSM for Run Command:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ssm:GetParameter", "Resource": "arn:aws:ssm:*:*:parameter/pulpfixer/*" },
    { "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "<kms key arn of the parameters>" },
    { "Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "arn:aws:secretsmanager:*:*:secret:pulpfixer/*" }
  ]
}
```

Also attach `AmazonSSMManagedInstanceCore`. On the operator side, scope `ssm:SendCommand` on `AWS-RunShellScript` by instance tag, so only the right people can run `--apply` on production-tagged hosts.

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

## Shortcuts

`pf ds` is `pf deploy staging` and `pf dp` is `pf deploy production` (only a `deploy:production` script or `pf.json` entry; always confirms). Add more in `src/commands/shortcuts.ts`.
