---
name: pf-repo
description: Work in a repository through pulpfixer's tools. Use when starting on a repo, when you need its build, test or deploy commands, or when you are unsure how the project is put together.
---

# Work in this repo

1. Call `pf_commands` and treat that result as the source of truth for this repo. Do not invent `npm`, `make` or `cargo` commands when pf already resolved one.
2. Run `build`, `test`, `lint` or `install` with `pf_run`. `dev` keeps running, so ask the user to start it in a terminal.
3. Call `pf_skills` when the task might have a skill, then `pf_skill` for the one that fits, and follow it.
4. After changing a module, call `pf_bump` with `minor` (or `major` for a breaking change). Never edit a version in a manifest by hand.
5. A deploy is `pf_deploy_staging` with no `confirm`, shown to the user, then `confirm: true` only after they agree. Production is never a target.
6. Leave secrets alone. Do not read, print or write tokens. An `.npmrc` line that says `${NPM_TOKEN}` stays as it is.
