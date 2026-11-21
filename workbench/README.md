# Workbench

Ad-hoc and repeatable tools for one-off or recurring tasks, plus the files they read and write.
Part of the Pulpfixer repo (a pnpm workspace member, never published). Tools are committed; `files/` and `scratch/` contents never are.

```
tools/      PERMANENT tools: committed, registered with pf (pf <name>), listed in the pf menu
scratch/    ONE-OFFS: never committed. Delete them, or rewrite them when the job changes
lib/        shared helpers (open a DynamoDB connection, work out the file folders, the --live switch, logging)
files/      ALL inputs, outputs and logs: never committed, one folder per tool: files/<tool>/{in,out,logs}
pulpfixer.json   the permanent tools and their descriptions
```

## Everyday

```bash
pf wb-new my-task                         # a new one-off in scratch/my-task (from the template)
node scratch/my-task/index.mjs            # simulates: reads run, writes are only logged
node scratch/my-task/index.mjs --live     # writes for real
pf wb-promote my-task "what it does"      # keep it: moves it to tools/ and registers `pf my-task`
pf wb-promote my-task --repo              # or give it a repo of its own, in the suite's repos folder (see below)
pf ddb-check --connection=sdlc-ddb        # a permanent tool: check a saved DynamoDB connection
pf                                        # the menu lists every registered tool
```

- **Simulation first.** A tool does not change anything unless you pass `--live`. `ctx.openDb()` opens the connection with writes simulated (the statements, never their values, go to the log). Without a tool runner, `lib/db.mjs` `openDb()` is read-only.
- **A tool is a folder with an `index.mjs`** that calls `runTool(import.meta.url, async (ctx) => { ... })` (see `lib/tool.mjs`). Its name is the folder name.
- **Logs** go to `files/<tool>/logs/`. They are never deleted: once a tool has more than 20, the older ones are *moved* (not copied or compressed) to `files/<tool>/logs/archive/<year-month>/`, so you can always look back, e.g. to see what a PII anonymization run changed.
- **Secrets** never go in the repo. AWS uses your profiles, `pf db add` stores only references to secrets, and any `.env*` is git-ignored.

## A tool of its own: `--repo`

`pf wb-promote <name> --repo ["what it does"] [--dry-run] [--no-git] [--no-repo]` turns a scratch tool into a repo at `<repos folder>/<name>` (the folder `pf suite config` sets, `~/dev` by default; `pf suite config get reposDir` prints it). The repo holds `tools/<name>/` (moved from `scratch/`), a copy of `lib/`, `pulpfixer.json` (registers `pf <name>`), `package.json` (kit, plugin-db and db-dynamodb at the versions in this repo), `.gitignore`, `.npmrc` (`${NPM_TOKEN}`), a README and `files/`. It then runs `git init` and `pf repo --no-deploy` there.

- It refuses when the target folder already exists or the scratch tool is missing, and `--dry-run` writes nothing.
- `files/<name>/` stays here (it can hold user data): copy what the tool needs yourself.
- The scratch tool is removed only after the repo is written. The copy of `lib/` is a snapshot: it does not follow later changes here.
- It imports the built kit, so run `pnpm build` after a kit change.
- Without `--repo`, `wb-promote` is unchanged: it moves the tool into `workbench/tools/`.

## Keeping things out of git

- `files/` and `scratch/` **exist in the repo** (an empty `.gitkeep` in each) but nothing inside them is ever committed. Same for `node_modules/` and `.env*`.
- **Exclude all permanent tools:** uncomment `tools/` in `.gitignore`, and run `git rm -r --cached tools` if some were already committed.
- **Exclude one tool, only on this machine:** add `workbench/tools/<name>/` to `.git/info/exclude`. That file is never committed.

## Setup

`workbench/` is a normal member of the repo's pnpm workspace (it is not a published package: the release script ignores it). It needs nothing of its own:

```bash
pnpm install       # at the repo root, like everything else
pnpm build         # the workbench uses the built kit, plugin-db and db-dynamodb
cd workbench       # run pf from here to see the tools in pulpfixer.json
pf db add sdlc-ddb --driver dynamodb --region us-east-1 --profile sdlc   # a saved connection, if you have none
```
