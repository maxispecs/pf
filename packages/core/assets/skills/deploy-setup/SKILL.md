---
name: deploy-setup
description: Teach pf how a repo deploys, so `pf deploy` (`pf d`) works there. Use when the repo has its own helper script for deploying (such as `./tl d` or `./al d`) that pf does not know, or when pf rp --deploy starts you. Reads the helper and writes a `deploy` entry in pf.json. Never runs the deploy.
---

# Wire `pf deploy` to this repo's own deploy

Some repos deploy through a hand-written helper at the root (`./tl d`, `./al d`) instead of a script pf can read. Your job is to find the right command and record it in `pf.json`. Do not run it.

## 1. Read how the repo says it deploys

1. Call `pf_commands` to see what pf already resolved. If it already lists a staging, production or repo deploy, stop and say so.
2. Read the repo's own notes first: `AGENTS.md`, `README`, `docs/**` pages about deploying or releasing.
3. Read the helper scripts at the root: executable files such as `./tl` or `./al`, then a `Makefile`, a `justfile`, `cli/`. The user's prompt may list candidates pf ranked; check them, do not trust the ranking blindly.

## 2. Pick the command

- Prefer the helper that runs from this checkout on a dev machine. A `GWLOCAL=True` marker is one sign (`tl`, `al`).
- Never wire a server-only helper. One that needs `$GWHOME`, `systemctl`, `sudo` or a server path does the wrong thing on a laptop (for example `a.sh deploy` runs `prefect deploy` on the server).
- Find the deploy branch: `if [ "$1" = "d" ] || [ "$1" = "deploy" ]`. Use the long name when it has one (`./al deploy`) and the short one otherwise (`./tl d`).
- A helper may have several nearby entries (`commit`, `compile`, `version`). Wire only the deploy.
- If nothing in the repo deploys, say so and stop. Do not invent a command.

## 3. Understand what it does

Describe it in one line for the `description`: what it changes and where it ends. For example "Bump version, compile prefect.yaml, commit, push".

- If it runs `git add .`, it commits everything in the tree. Say so to the user.
- If a later step happens elsewhere (the push triggers CI, or the servers run another command afterwards), put that in the description.
- If it takes an optional commit message (the helper builds a commit from `$2` or `$*`), it takes a message.

## 4. Ask which environment it is

If the prompt already names the pf.json key (`deploy`, `deploy:staging` or `deploy:production`), use that key and do not ask. `pf rp` asks before it starts you, then exits when you finish.

Otherwise ask the user once: staging, production, or "just deploy". A command the repo does not tie to an environment goes under the plain name.

| Answer | `pf.json` key | What `pf` does |
|---|---|---|
| not sure, or a push that releases | `deploy` | always asks first, needs `--yes` without a terminal |
| staging | `deploy:staging` | the usual staging flow (`pf ds`, `pf d`) |
| production | `deploy:production` | always asks first (`pf dp`) |

Default to `deploy`. Never choose production for the user.

## 5. Write `pf.json`

Add the entry under `commands`, keeping everything already in the file, including its `id`, which links the repo to pf's state; never change or add it (create the file at the repo root if missing):

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

## 6. Check

Do not run the deploy. When the prompt says pf will preview it, stop after writing `pf.json`: pf runs the preview once you exit. Otherwise run `pf deploy --dry-run` (it only prints) and show the user the line it printed. Tell them how to use it:

- `pf d` runs it after asking.
- `pf d "fix login"` passes a commit message when `"message": true` is set.
