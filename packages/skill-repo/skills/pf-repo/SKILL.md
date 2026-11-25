---
name: pf-repo
description: Work in a repository through pulpfixer's tools. Use when starting on a repo, when you need its build, test or deploy commands, or when you are unsure how the project is put together.
---

# Work in this repo

1. Call `pf_commands` and treat that result as the source of truth for this repo. Do not invent `npm`, `make` or `cargo` commands when pf already resolved one.
2. Run `build`, `test`, `lint` or `install` with `pf_run`. `dev` keeps running, so ask the user to start it in a terminal.
3. Call `pf_skills` when the task might have a skill, then `pf_skill` for the one that fits, and follow it.
4. After changing a module, call `pf_bump` with `minor` (or `major` for a breaking change). Never edit a version in a manifest by hand.
5. Only `pf_commands` says what `pf d` runs. A root script named `deploy_*` (`deploy_migrations.sh`) is usually one step of a deploy or a server hook, not a deploy, and you never add a deploy entry to `pulpfixer.json` outside the `deploy-setup` skill.
6. A deploy is `pf_deploy_staging` with no `confirm`, shown to the user, then `confirm: true` only after they agree. Production is never a target.
7. Leave secrets alone. Do not read, print or write tokens. An `.npmrc` line that says `${NPM_TOKEN}` stays as it is.

## The pf link (still changing)

pf remembers a repo in two places: the `id` in the repo's `pulpfixer.json`, and a record under `~/.pf/repos/<id>.json` on the user's machine. The record holds what stays out of the repo, such as security-related settings, the checkout paths and the git remote. The id connects the two, so the record survives a moved checkout or a renamed remote.

This connection is still under active development. Its format and rules change between pf releases, so a repo that was linked before sometimes needs `pf rp` again to update the connection.

- `pf_commands` ends with a `pf link:` line. When it says anything other than `linked` (`stale`, `unlinked` or `foreign`), tell the user what it reports and ask them to run `pf rp` (it may ask them a question). Carry on with the task; a stale link does not block builds, tests or deploys.
- Never write, change or remove the `id` in `pulpfixer.json` yourself, and never copy it into another repo. Keep it when you edit `pulpfixer.json` for other reasons.
- Never read or write files under `~/.pf/repos/`. pf owns them.
- `pf.json` is the old name of `pulpfixer.json`. pf still reads it, and `pf rp` renames it. Never create a `pulpfixer.json` next to it; ask the user to run `pf rp`.
