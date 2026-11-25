# pf

One command line for every repo, in any language. Run `pf` in a repo to get its menu; run it anywhere else to get a fallback menu (run a skill, about, doctor).

```
pf              menu for this repo
pf dev          run the app locally (any language)
pf ver          versions and bumps (the /version skill)
```

Every invocation prints its version (`pf v2.0`) on stderr.

## Install

One line, with Node >= 18 and npm (no token: pf and its packages are public on cellars):

```bash
[ -w "$(npm root -g)" ] || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH" && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.$(basename "$SHELL")rc; }; npm install -g pulpfixer --registry https://cellars.staging.pangenea.com/ && pf setup --yes && pf skill install --all && pf suite enable --yes
```

That installs pf, sets the machine up, installs the agent skills and applies the pulpfixer suite to Cursor (the standard extensions and settings, and Background Tone).

Just pf, without the skills and the suite:

```bash
[ -w "$(npm root -g)" ] || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH" && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.$(basename "$SHELL")rc; }; npm install -g pulpfixer --registry https://cellars.staging.pangenea.com/ && pf setup
```

The first part only runs when npm's global directory is not writable by you (Homebrew Node: `EACCES`): it switches npm to a user-owned prefix, `~/.npm-global`, and adds its `bin` to your shell rc, so no `sudo` is needed. `--registry` applies to this install only, so your default npm registry is left alone. `pf setup --yes` accepts every step without prompts (the full one-liner uses it). An `NPM_TOKEN` (token from #frontend) is only needed to publish or to install private registry plugins.

Or from a checkout of this repo:

```bash
scripts/install.sh                # latest published version
scripts/install.sh --from-source  # build this checkout, pack its packages and install them globally
scripts/install.sh --plugin jira  # also install a registry plugin (repeatable)
scripts/install.sh --dry-run      # show what would happen
```

`pf` replaces the legacy `pulpfixer` 1.x package. The installer and `pf setup` remove the old global install (its data in `~/.pulpfixer` is left alone). `pf` is a monorepo: the `pulpfixer` package depends on `@pulpfixer/kit` and the built-in plugins, so one global install brings them all. Update with `pf update` (pf, installed plugins and registry skills in one go); remove with `pf uninstall`. `pf doctor` checks the machine.

## Commands

| Command | What it does |
|---------|--------------|
| `pf` | Menu: this repo's commands, or the fallback menu outside a repo. Includes the agent |
| `pf troubleshoot [prompt]` (`pf t`) | Troubleshoot this repo's deployment: pf reads how it deploys, links its registered AWS profile (wizard), checks the credentials, then starts the agent with scoped AWS access and fix actions you approve one call at a time. `--agent`, `--profile`, `--link`, `--dry-run` |
| `pf agent [prompt]` | Open the coding agent (Claude Code, Codex or Cursor) with pf's tools and skills. `--agent`, `--profile`, `--dry-run`. `pf agent use [id]` sets the default |
| `pf profile [list\|show\|use\|add\|remove\|check]` | Project profiles: which AWS account a repo uses and what the agent may read there. See [Profiles](#profiles-and-aws-access-for-the-agent) |
| `pf aws [grants\|revoke]` | AWS access the agent was granted: list it, end it |
| `pf list` | The same list, static (for scripts and agents) |
| `pf dev`, `build`, `test`, `lint`, `install` | Resolved per repo, see below. `--dry-run` prints, `--pick` chooses when several exist, `-- <args>` passes args on |
| `pf ver [list\|bump\|init\|sync]` | Major.minor versioning with the `/version` skill's CLI |
| `pf doc` (`pf docs`) | Run the docs site (Nextra, Docusaurus, VitePress, Starlight, mkdocs, Sphinx, mdBook, Hugo) |
| `pf deploy` (`pf d`) | Deploy: staging if configured, else production, else the repo's own `deploy` (`pulpfixer.json`, a `deploy` script or `./a deploy`; production-like, always asks). `pf d "message"` passes a commit message to a target marked `"message": true`. `--dry-run`, `--yes`, `-m` |
| `pf deploy staging` | Deploy to staging. `--dry-run`, `--yes`. Never production |
| `pf skill [name]` | Pick and run an agent skill. `available`, `install`, `update`, `remove` manage skills from the registry |
| `pf plugin [list\|available\|install\|update\|remove]` | Administer plugins from the registry. Without a command it opens an interactive menu. See [Plugins](#plugins) |
| `pf update` (`pf u`) | Update pf, installed plugins, registry skills and your copies of pf's own skills, then this repo's copies of the `version` and `pnpm` helpers. `--check`, `--yes`, `--dry-run` |
| `pf init` | Write `pulpfixer.json` for this repo from what was detected |
| `pf repo` (`pf rp`) | Hook pf's tools into this repo, or update them: the `/pnpm` root commands (`pnpm ask`, `pnpm doc`, `pnpm deploy:staging`) and `/version` versioning (`versions.json`, `pnpm ver`). Updates every older ver CLI copy, prints what it did. Also reports what `pf d` runs, or, when the repo deploys through its own helper (`./tl d`, `./al d`), offers to start the agent with the `deploy-setup` skill, which writes the `pulpfixer.json` entry (never runs the deploy), but only for a whole deploy that works from the checkout: a step such as `deploy_migrations.sh`, a platform hook, a stub or a server-only helper is listed as not wired. `--dry-run`, `--no-pnpm`, `--no-ver`, `--no-deploy`, `--deploy`. Never commits |
| `pf repo commit` (`pf g`) | Commit everything uncommitted (`git add -A`) with a message the agent writes from the last Cursor chat of the repo (`~/.cursor/projects/<repo>/agent-transcripts/`), or made from the chat's first request and last answer without an agent. Shows the files and message and asks first (`--yes` without a TTY). `-m <message>`, `--chat <id>`, `--agent <name>`, `--no-agent`, `--dry-run`. Never pushes (`pf gp`). Also the `repo:commit` action (`pf actions feature repo:commit` makes it a Repo Identity button) |
| `pf host ...` | pf on EC2 instances: install, login, update, security patching and the fix agent. See [Hosts](#hosts-ec2) |
| `pf s3 <file...>`, `pf dl [name]` | AWS plugin: upload to and download from a shared exchange bucket. See [AWS plugin](#aws-plugin) |
| `pf setup`, `update`, `uninstall`, `doctor` | Machine tooling |
| `pf about`, `pf help`, `pf --version` | Info |

### How commands are resolved

For `dev`, `build`, `test`, `lint` and `install`, in order:

1. `pulpfixer.json` `commands.<name>`
2. A script or target the repo already has: `package.json` scripts, `composer.json` scripts, Makefile and justfile targets
3. A stack default: Node (pnpm, npm, yarn, bun), Python (uv, poetry, pipenv, pip), Go, Rust, Java (Maven, Gradle), .NET, Ruby, PHP, Elixir, Swift, Docker Compose

### pulpfixer.json

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

`pf skill` finds skills in `~/.cursor/skills`, `~/.cursor/skills-cursor`, `~/.agents/skills`, `~/.claude/skills`, the repo's `.cursor/skills`, `.agents/skills`, `.claude/skills`, pf's own folder `~/.pf/skills`, and the skills bundled with pf, in that order: a skill in an earlier directory wins over a later one with the same name. Skills in `~/.pf/skills` and the bundled ones run through `pf agent`, which reads them with the `pf_skill` tool, so they work with any agent CLI. `version` (`ver`) and `pnpm` run their scripts directly. Others run through the agent CLI.

#### Skills from the registry

The skills repo publishes each skill to cellars as `@pf-skills/<name>`, or `@pf-skills-<name>/<name>` when it has its own package. pf installs and updates them:

```bash
pf skill available                  # registry skills, their versions and where they are installed
pf skill install version bp         # into pf's own folder, ~/.pf/skills (version comes from pf, bp from the registry)
pf skill install --all --to claude  # every skill, into ~/.claude/skills instead
pf skill update [name...]           # bring registry installs to the latest (--check only reports)
pf skill remove version             # delete an install
```

`--to` takes `pf` (the default), `cursor`, `claude`, `agents` or `all` (comma-separated); use an agent folder when that agent should see the skill outside `pf agent`. An install keeps the package's `package.json` in the skill folder; that marks it as a registry install. pf never replaces a symlink (a skills repo checkout) or a folder it did not install unless you pass `--force`. `pf update` also updates every registry install. A skill named `available`, `install`, `update`, `remove` or `run` runs as `pf skill run <name>`.

#### Skills that ship with pf

`version`, `pnpm`, `pf-repo` and `deploy-setup` are packages that pf depends on (`@pulpfixer/skill-version`, `@pulpfixer/skill-repo`), so they match the pf you run and pf reads their helper files (`pf ver`, `pf repo`) straight from its install. `pf skill install version pnpm --to claude` (or `--all`) copies them into an agent's folder, and `pf update` refreshes such copies. `pf update` also removes an old registry install of `ver` or `pnpm` from `~/.pf/skills` (a symlinked checkout is left alone and reported), and inside a repo refreshes the repo's own copies: `scripts/version.mjs` (when its revision is older; a newer one is kept) and `scripts/tasks.mjs` (only a copy that is already the pnpm helper). It never installs a helper (that is `pf repo`), never commits, and `--check` / `--dry-run` only report.

### Agent

The full guide, with examples of usage and of writing agent tools, is [docs/agent.md](docs/agent.md).

`pf agent` (also the Agent entry in the `pf` menu) starts Claude Code, Codex or Cursor with a system prompt built from this repo, the pf tools (`pf mcp`) and the skills above. The agent CLI is chosen with `--agent`, `PF_AGENT`, or `"agent"` in `~/.pf/config.json` (`claude`, `codex` or `cursor`; `claude-code` and `cursor-agent` are accepted too). Otherwise the first installed CLI is used, and a terminal asks the first time more than one is installed. `pf agent use cursor` also registers the pf MCP server in `~/.cursor/mcp.json`.

The tools can list and run this repo's commands, bump versions and deploy to staging. A staging deploy returns the plan until the call passes `confirm`, and the agent CLI asks before running it. Production is never targeted.

### Profiles and AWS access for the agent

A profile names the AWS account a project uses and caps what the agent may read there. Profiles live in `~/.pf/config.json` (nothing secret, only names):

```bash
pf profile add acme --aws-profile acme-readonly --account 123456789012 --region eu-west-1 --scopes identity,ec2,ecs,logs
pf profile use acme        # default everywhere, or name it per repo in pulpfixer.json
pf profile check           # sts get-caller-identity, compared with the pinned account
```

A repo picks its profile in `pulpfixer.json` and may narrow it, never widen it (a cloned repo is not trusted):

```json
{ "profile": "acme", "agent": { "aws": { "scopes": ["identity", "ecs"] } } }
```

The profile is the first of `--profile`, `PF_PROFILE`, `pulpfixer.json` `profile` and the default. Without `--scopes` a profile allows every scope except `logs` (log text can hold secrets), for at most 60 minutes per grant (`--max-ttl`, up to 480).

The agent never gets credentials. It calls `pf_aws_profile`, then `pf_aws_request_access` with scopes and a reason, and pf asks you in a dialog inside the agent CLI (MCP elicitation) showing the profile, account, scopes, regions and time. After you approve, `pf_aws_whoami` and `pf_aws_describe` run read-only calls (`describe-*`, `list-*` and a few `get-*` per scope; never secret values, file contents or user data) with the profile, after checking the pinned account. Secret-looking values are redacted. A grant belongs to one agent session and ends when it expires, when the session ends, or with `pf aws revoke`. `pf aws grants` lists them, and every request, decision and call is logged in `~/.pf/agent/audit/`. Claude Code runs these tools unasked because pf asks you itself. If a CLI cannot show the dialog, Claude sessions refuse the grant, and Codex and Cursor fall back to their own tool prompt. Use a read-only IAM role (`ViewOnlyAccess`) for the AWS profile as well: pf's scopes are a second layer.

`pf troubleshoot` (`pf t`) is agent mode for a misbehaving deployment. pf first reads how the repo deploys (CI workflows, CDK/SAM/Serverless/SST, Terraform, task definitions: staging and production commands, accounts, regions, clusters, services, functions, log groups) and resolves the AWS profile. Only profiles registered in `~/.pf/config.json` are supported; when none applies, a wizard lists the registered profiles and the ones in `~/.aws/config` that match the repo, registers the one you pick if it is new, and writes `"profile"` to `pulpfixer.json`. It then checks that the credentials resolve to the pinned account (offering `aws sso login` when the session expired) and starts the agent with the deployment in its persona and the bundled `troubleshoot` skill. Beyond read grants, the agent can ask for a fix with `pf_aws_act` (`ecs update-service`, `ecs stop-task`, `ec2 reboot-instances`, `autoscaling set-desired-capacity`, `rds reboot-db-instance`). Fixes are off until your profile lists them (`pf profile add <name> --actions ...`), and every single call shows you the exact command and runs only if you approve it. `pf t --link` runs only the wizard, `pf t --dry-run` prints what pf found and what it would start. See `docs/agent.md`.

## Plugins

A plugin adds commands (and menu entries) to pf. Some ship inside pf (the built-in `aws` plugin); the rest come from the cellars registry as `@pf-plugins/<name>` (or `@pf-plugins-<name>/<name>`) and are remembered per user.

```bash
pf plugin                          # interactive: list, install, update, remove
pf plugin list                     # built-in and installed plugins; a plugin that fails to load is named with the reason
pf plugin available                # what the registry has, and what is installed
pf plugin install jira [x@1.2]     # latest (or that version) into ~/.pf/plugins
pf plugin update [name...]         # bring installed plugins to the latest (--check only reports)
pf plugin remove jira
```

Installed plugins live in an npm prefix at `~/.pf/plugins`; its `package.json` `dependencies` are the list pf remembers, so a plugin stays installed across `pf update`, which updates them along with pf and the registry skills. Only the `@pf-plugins` scope installs, because a plugin runs inside pf with your rights. A plugin can add commands but never replaces a built-in one, and one that throws on load is skipped with a note in `pf plugin list`. `PF_NO_PLUGINS=1` skips loading them (to debug).

**Writing a plugin:** a package named `@pf-plugins/<name>` whose entry point default-exports a `Plugin` (`@pulpfixer/kit/plugin`: `name`, `summary`, `commands`, optional `entries(ctx)`, `tools(ctx)` (agent tools served by `pf mcp`, `@pulpfixer/kit/agent-tool`) and `api`). Depend on `@pulpfixer/kit` for the types and helpers. Publish it to cellars; `pf plugin install <name>` does the rest.

**IO and pipes:** the built-in `io` and `csv` plugins move rows between places. `pf io` lists the IO adapters (`db` on a `pf db` connection, `csv` files, `memory`, `stdout`, and `@pulpfixer/io-<name>` add-ons); a **pipe** (`@pulpfixer/pipe-<name>`, its own repo, made with `pf template apply pipe-package <name>`) declares inputs and outputs and codes the coupling, then runs as `pf <name> <pipe> [--dry-run] [--yes]`: it shows where it reads and writes, asks before writing, streams in batches, and rolls a database output back (or discards the CSV file) when it fails. `pf csv show|columns <file>` looks at a CSV file. `pf plugin install pipe-<name>` / `io-<name>` install pipes and adapters. See the IO, CSV, Writing a pipe package and Writing an IO adapter pages of the docs (`pf docs`).

## AWS plugin

Plugins are separate packages (`packages/plugin-<name>`, built on `@pulpfixer/kit`) and are listed in `packages/pulpfixer/src/plugins/index.ts`; each one contributes commands and optional menu entries. The `aws` plugin wraps the aws CLI (it must be on PATH) and starts with a shared **exchange bucket**:

```bash
pf s3 --setup              # wizard: asks for bucket, profile, folder and region (prefilled with what is saved)
pf s3 --setup --bucket my-exchange [--profile exchange] [--prefix shared] [--region eu-west-1]   # no questions
pf s3 report.pdf            # upload to s3://my-exchange/shared/report.pdf (profile "exchange")
pf s3 a.zip b.zip           # several files; --as <name> renames a single one
pf dl                       # pick a file (newest first, arrows + enter) and download it to the current dir
pf dl report.pdf            # download by name (exact, case-insensitive, or a unique part of the name)
pf dl --list                # print the listing (also what you get when piped); -o <dir>, --force
```

Settings live in `plugins.aws.exchange` of `~/.pf/config.json`; `PF_EXCHANGE_BUCKET`, `PF_EXCHANGE_PROFILE`, `PF_EXCHANGE_PREFIX` and `PF_EXCHANGE_REGION` override them. The profile defaults to `exchange`. pf never reads credentials; the aws CLI resolves them from the profile. All commands support `--dry-run`, and `pf dl` is also in the menu. To add another AWS shortcut, put a command in `packages/plugin-aws/src/commands/` and list it in `packages/plugin-aws/src/index.ts`.

## YubiKey plugin

The `yubikey` plugin wraps [`ykman`](https://docs.yubico.com/software/yubikey/tools/ykman/) (it must be on PATH: `brew install ykman`). pf never sees a secret: ykman asks for the OATH password and for a touch itself, and the code is calculated on the key.

```bash
pf otp                      # pick an account (type to filter), then touch the key if it asks: the code prints on stdout
pf otp github               # straight to one account (a unique part of its name); several matches are listed
pf otp github --copy        # also put the code on the clipboard (pbcopy, wl-copy, xclip, xsel or clip)
pf otp --list               # account names, no codes (also what you get when piped with no account)
pf otp --all                # ykman's table of every code (touch accounts show [Requires Touch])
pf otp -d 11447176 github   # with several keys plugged in; --hidden includes hidden accounts

pf yk                       # in a terminal: pick audit, status, list, oath, fido, creds, piv or pgp
pf yk audit                 # read-only security check, with the command that fixes each finding
pf yk audit --strict        # exit 1 when there is a warning
pf yk status | list | oath | fido | creds | piv | pgp    # the matching ykman info view
```

The audit reads `ykman info` and each enabled application's info, and flags: firmware before 5.7 (EUCLEAK, YSA-2024-03), OATH accounts without a password, no FIDO2 PIN, PINs with attempts used up, a TDES PIV management key on firmware that defaults to AES, OpenPGP without KDF or with the signature PIN cached, and Yubico OTP left enabled. It never changes the key. Commands support `--dry-run` and `--device <serial>`; both appear in the menu under Security. To add another, put a command in `packages/plugin-yubikey/src/commands/` and list it in `packages/plugin-yubikey/src/index.ts`.

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
pnpm ver bump packages/pulpfixer minor   # a published version cannot be reused
pnpm release                # typecheck, test, build, npm publish --dry-run
pnpm publish:cellars        # the real publish (asks you to type the version)
```

## Shortcuts

`pf docs` is `pf doc` (run the repo's docs site; `--dry-run` previews, `--pick` chooses between several), `pf r` is `pf dev` (run the repo), `pf i` is `pf install` and `pf il` / `pf install-local` is `pf install local` (the repo's `install:local` / `install:<to>` script or `pulpfixer.json` entry, found in package.json, composer and the local CLI, no confirmation; `pf install` with no target prefers `install:local` and falls back to the dependency install, `--deps` forces that), `pf rp` is `pf repo`, `pf g` is `pf repo commit`, `pf d` is `pf deploy` (staging if configured, else production, else the repo's own deploy), `pf ds` is `pf deploy staging` and `pf dp` is `pf deploy production` (only a `deploy:production` script or `pulpfixer.json` entry; always confirms). `pf ps` is `pf publish staging`: it runs the repo's `publish:cellars` (or `publish:staging`) script, or the `publish:staging` / `publish:cellars` entry in `pulpfixer.json`, and always confirms (`--yes` without a TTY, `--dry-run` to preview). In a repo that only publishes (no deploy target, no skipped platform), `pf d`, `pf ds` and `pf dp` run that publish, and in a repo with no publish target `pf ps` runs the staging deploy. Add more in `packages/pulpfixer/src/commands/shortcuts.ts`.
