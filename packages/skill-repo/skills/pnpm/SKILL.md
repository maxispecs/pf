---
name: pnpm
description: Enhances a local pnpm repo (single package or workspace monorepo) with predefined root commands - `pnpm ask` lists every root script grouped and described, `pnpm doc` starts the local docs site, and `pnpm deploy:staging` deploys to staging - adding the last two only where a docs site or a staging target exists. Installs one zero-dependency helper script and wires package.json. Use when the user invokes /pnpm, or asks to set up pnpm commands, a command list, a local docs command, or a staging deploy command in a pnpm repo.
---

# pnpm commands

Installs `scripts/tasks.mjs` into the target repo and wires these root scripts in its `package.json`:

| Command | What it does | Added when |
|---------|--------------|------------|
| `pnpm ask` | Lists the root scripts, grouped and described by the `scriptsInfo` field | Always |
| `pnpm doc` | Runs the docs site locally. Extra args are passed on: `pnpm doc --port 4000` | A docs site is found |
| `pnpm deploy:staging` | Deploys to staging. `--dry-run` prints the command and runs nothing | A staging target is found |

The names avoid pnpm built-ins: `pnpm deploy` and `pnpm docs` are pnpm commands, so the script names are `deploy:staging` and `doc`. Never rename them to `deploy` or `docs`.

`<skill>` is the directory containing this file. Run everything from the target repo root.

## Workflow

```
- [ ] 1. Run setup
- [ ] 2. Describe undescribed scripts
- [ ] 3. Fill gaps the user mentioned
- [ ] 4. Verify
- [ ] 5. Summarize
```

**1. Run setup.** It is idempotent, so it is safe to rerun after the repo changes:

```bash
node <skill>/scripts/tasks.mjs setup            # add --dry-run to preview
```

It copies itself to `scripts/tasks.mjs` (or `scripts/pnpm-tasks.mjs` if that name is taken by something else), adds each script that applies, and adds its `scriptsInfo` description. One row per command is printed:

| Status | Meaning |
|--------|---------|
| `added`, `updated`, `unchanged` | Wired to the helper |
| `kept` | The repo already has a script with that name. It is never overwritten (for example the `/bp` skill's `ask`, which reads the same `scriptsInfo`) |
| `skipped` | Nothing found, with the reason. The script is not added |

No `package.json` at the root: stop and tell the user. Do not ask anything else.

**2. Describe undescribed scripts.** The setup output ends with `needs a scriptsInfo description: a, b`. For each, add a short description (under 70 characters, imperative, no trailing period) to the root `package.json` `scriptsInfo`, in the group that fits:

```json
"scriptsInfo": {
  "Develop": { "dev": "Run every app in watch mode" },
  "Build & check": { "build": "Build every package", "test": "Run all tests" }
}
```

Format: `{ "<Group>": { "<script>": "<description>" } }`. Entries for scripts that do not exist are ignored. Reuse the groups already present; otherwise use `Develop`, `Build & check`, `Deploy`, `Tools`, `Help`.

**3. Fill gaps the user mentioned.** Only when setup skipped a command and the user said how it works (for example "we deploy staging with `./scripts/stage.sh`", or "docs are the Storybook"): write the script directly in `package.json` with a `scriptsInfo` entry, for example `"deploy:staging": "./scripts/stage.sh"`. Do not extend `tasks.mjs` for one repo. If the user said nothing, leave skipped commands skipped and say why in the summary.

**4. Verify.**

```bash
pnpm ask
pnpm doc --dry-run               # only if added
pnpm deploy:staging --dry-run    # only if added
```

Always use `--dry-run` for the deploy. **Never run `pnpm deploy:staging` without `--dry-run` and never start `pnpm doc` (it blocks) unless the user asked for it.**

**5. Summarize.** Show the `pnpm ask` output in a code block, then a short list of choices made. Example:

```
Choices made
- ask: added (scriptsInfo descriptions written for build, lint)
- doc: added -> pnpm --dir apps/docs run dev (apps/docs, Nextra)
- deploy:staging: added -> Vercel preview deploy from apps/web (uses a preview URL, not a custom "staging" environment)
- pnpm 12 note: pnpm itself has `docs` and `deploy` commands, hence `doc` and `deploy:staging`
```

## What is detected

Detection runs again on every call of `pnpm doc` and `pnpm deploy:staging`, so the commands follow the repo when it changes. First match wins.

**Docs site** (`pnpm doc`):
1. A root script `docs:dev`, `docs:start`, `doc:dev` or `docs`
2. A workspace package named or located like `docs`/`documentation`, or depending on Nextra, Docusaurus, VitePress, Starlight, Fumadocs or Vocs, with a `dev`/`start` script: `pnpm --dir <package> run dev`
3. The root package depending on one of those frameworks, with a `dev`/`start` script
4. A `.vitepress` folder in the root or `docs/`: `vitepress dev`
5. `mkdocs.yml`: `mkdocs serve` (needs MkDocs installed)

**Staging** (`pnpm deploy:staging`):
1. A root or workspace script named `deploy:staging`, `deploy-staging`, `staging:deploy`, `deploy:stage` or `stage:deploy`
2. A `.github/workflows/*stag*.yml` with `workflow_dispatch`: `gh workflow run <file>` (starts a remote run, needs the `gh` CLI)
3. Platform configs, in the root and every workspace package, all of which run in order if several exist:

| Found | Command |
|-------|---------|
| `firebase.json` and a `staging` project alias in `.firebaserc` | `pnpm run build && firebase deploy --project staging` |
| `wrangler.*` with a `staging` environment | `wrangler deploy --env staging` |
| `fly.staging.toml` | `fly deploy --config fly.staging.toml` |
| `serverless.*` | `serverless deploy --stage staging` |
| `sst.config.ts` | `sst deploy --stage staging` |
| `netlify.toml` | `netlify deploy --build` (draft deploy, never `--prod`) |
| `vercel.json`, `.vercel/project.json` or a `vercel` dependency | `vercel deploy` (preview deploy, never `--prod`) |

CLIs run through `pnpm exec` when installed locally, otherwise `pnpm dlx`. A platform that is present but has no staging setup (a Firebase project without a `staging` alias, a Worker without `[env.staging]`) is reported in the `skipped` reason instead of guessing. Production is never targeted.

## Rules

- Never overwrite an existing script of the same name. Mention `kept` rows in the summary.
- Do not commit unless the user asks.
- When the user adds a root script later, it needs a `scriptsInfo` entry too, or `pnpm ask` lists it under `Other`.
- Requires Node >= 18 in the target repo. No dependencies are installed.
