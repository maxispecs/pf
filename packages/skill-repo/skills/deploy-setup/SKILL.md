---
name: deploy-setup
description: Teach pf how a repo deploys, so `pf deploy` (`pf d`) works there. Use when the repo has its own helper script for deploying (such as `./tl d` or `./al d`) that pf does not know, or when pf rp --deploy starts you. Reads the helper and writes a `deploy` entry in pulpfixer.json, only for a whole deploy that works from this checkout (never a deploy step, a server hook or a stub). Never runs the deploy.
---

# Wire `pf deploy` to this repo's own deploy

Some repos deploy through a hand-written helper at the root (`./tl d`, `./al d`) instead of a script pf can read. Your job is to find the right command and record it in `pulpfixer.json`, but only when it is a real, whole deploy that works from this checkout. Do not run it.

A wrong link is worse than none: `pf d` runs what you write, and people trust it. When nothing qualifies, write nothing.

## 1. Read how the repo says it deploys

1. Call `pf_commands` to see what pf already resolved. If it already lists a staging, production or repo deploy, stop and say so.
2. Read the repo's own notes first: `AGENTS.md`, `README`, `docs/**` pages about deploying or releasing.
3. Read the helper scripts at the root: executable files such as `./tl` or `./al`, then a `Makefile`, a `justfile`, `cli/`. The user's prompt may list candidates pf ranked, and scripts pf already ruled out; check the candidates, do not trust the ranking blindly, and do not wire a script the prompt says is ruled out.
4. Read what runs the deploy outside the checkout: `appspec.yml`, `bitbucket-pipelines.yml`, `.github/workflows`, `Procfile`, `.platform/`, `.ebextensions/`, `buildspec.yml`. They tell you which scripts are server hooks and which steps CI runs.

## 2. What counts as a deploy

A deploy is the **whole release, end to end**, that a person runs **from this checkout on their own machine**, and that leaves the code running in an environment. Build and upload, `prefect deploy`, `cdk deploy`, `fly deploy`, or a push that the repo's own notes say releases.

These are **not** a deploy, even when the file name or the text says "deploy":

| Looks like a deploy | Why it does not count |
|---|---|
| `deploy_migrations.sh`, `deploy_clear_cache.sh`, `deploy_assets.sh`, `deploy_before.sh`, `deploy_after.sh`, `restart.sh`, `rollback.sh`, `smoke-test.sh` | One step of a deploy. Running it alone does only that step (migrations, a cache clear, a restart). |
| A script listed in `appspec.yml` `hooks` (CodeDeploy `BeforeInstall`, `AfterInstall`, ...), `.platform/hooks/`, `.ebextensions/`, a `Procfile` `release:` line, a container entrypoint | A hook the platform runs on the server after it receives the code. It assumes server paths and users. |
| A step in `bitbucket-pipelines.yml`, a GitHub workflow or other CI that needs pipeline variables or a CI-only login | CI runs it. A laptop has no such variables. |
| A script that is commented out, only `echo`es, or says "legacy" or "TODO" | A stub. It does nothing. |
| A helper that needs `$GWHOME`, `systemctl`, `sudo`, `/var/www`, `/srv`, `/opt` or a server user | It works on the server, not on a laptop (for example `a.sh deploy` runs `prefect deploy` on the server). |

A file name is not evidence. Read the body: `deploy_*.sh` is usually one step, and a script with an unrelated name may hold the real deploy.

If the only thing a repo has is CI (a pipeline deploys on push), then pf has nothing to run locally. Do not wire a bare `git push` unless the repo's own notes say a push to that branch deploys.

## 3. Pick the command

- Prefer the helper that runs from this checkout on a dev machine. A `GWLOCAL=True` marker is one sign (`tl`, `al`).
- Never wire a server-only helper. One that needs `$GWHOME`, `systemctl`, `sudo` or a server path does the wrong thing on a laptop (for example `a.sh deploy` runs `prefect deploy` on the server).
- Find the deploy branch: `if [ "$1" = "d" ] || [ "$1" = "deploy" ]`. Use the long name when it has one (`./al deploy`) and the short one otherwise (`./tl d`).
- A helper may have several nearby entries (`commit`, `compile`, `version`). Wire only the deploy.
- If nothing in the repo is a whole deploy (section 2), say so and stop. Do not invent a command, and do not settle for the closest thing: a migrations step or a server hook is not a deploy.

## 4. Understand what it does

Describe it in one line for the `description`: what it changes and where it ends. For example "Bump version, compile prefect.yaml, commit, push".

- If it runs `git add .`, it commits everything in the tree. Say so to the user.
- If a later step happens elsewhere (the push triggers CI, or the servers run another command afterwards), put that in the description.
- If it takes an optional commit message (the helper builds a commit from `$2` or `$*`), it takes a message.

## 5. Check that it works here

Before you write anything, confirm from the files alone that the command can run on this machine. These checks only read; running the command or a dry run of it is not one of them.

- Every program it calls exists: `command -v <program>` (`aws`, `rsync`, `fly`, `prefect`, `docker`, ...). A missing program means it is not set up here.
- Every file it sources or runs is in the checkout (`. ./env.sh`, `./scripts/build.sh`), and every folder it `cd`s into exists on a laptop (not `/var/www/...`).
- A `git push` pushes to a remote that exists: `git remote -v`.
- For each environment variable it needs, check only that the name is set (`[ -n "${NAME:-}" ]` or an `.env.dist` entry). Never print a value, and never read a token or key file.

If anything is missing, do not wire it. Tell the user what is missing, so they can set it up and run `pf rp --deploy` again.

## 6. Ask which environment it is

If the prompt already names the pulpfixer.json key (`deploy`, `deploy:staging` or `deploy:production`), use that key and do not ask. `pf rp` asks before it starts you, then exits when you finish.

Otherwise ask the user once: staging, production, or "just deploy". A command the repo does not tie to an environment goes under the plain name.

| Answer | `pulpfixer.json` key | What `pf` does |
|---|---|---|
| not sure, or a push that releases | `deploy` | always asks first, needs `--yes` without a terminal |
| staging | `deploy:staging` | the usual staging flow (`pf ds`, `pf d`) |
| production | `deploy:production` | always asks first (`pf dp`) |

Default to `deploy`. Never choose production for the user.

## 7. Write `pulpfixer.json`

Add the entry under `commands`, keeping everything already in the file, including its `id`, which links the repo to pf's state; never change or add it (create the file at the repo root if missing). A `pf.json` is the same file under its old name: when the repo has one and no `pulpfixer.json`, rename it to `pulpfixer.json` unchanged, then edit that. Never keep both.

```json
{
  "commands": {
    "deploy": {
      "run": "./al d",
      "message": true,
      "description": "Bump version, compile prefect.yaml, commit, push"
    }
  }
}
```

- `run` is the command as typed from the repo root. It is a shell line.
- Set `"message": true` only when the command makes a commit and takes a commit message as its last argument. pf then passes `pf d "fix login"` on as one quoted argument. Leave it out otherwise: pf warns and drops a message that a command does not take.
- Add `"cwd"` only when the command must run in a subfolder.
- Do not run the command, not even with a dry-run flag of your own. Do not read or print tokens or secrets.

## 8. Check

Do not run the deploy. When the prompt says pf will preview it, stop after writing `pulpfixer.json`: pf runs the preview once you exit. Otherwise run `pf deploy --dry-run` (it only prints) and show the user the line it printed. Tell them how to use it:

- `pf d` runs it after asking.
- `pf d "fix login"` passes a commit message when `"message": true` is set.

## When nothing qualifies

Write nothing to `pulpfixer.json`. Finish with one line per script or step you ruled out and why, for example:

- `deploy_migrations.sh`: one step (migrations), and `appspec.yml` runs it as an `AfterInstall` hook on the server.
- `bitbucket-pipelines.yml`: CodeDeploy runs on push to `main`; there is nothing to run from a laptop.

Then say what the repo would need for `pf d` to work, such as a local `deploy` script, and stop. pf reports that nothing was wired.
