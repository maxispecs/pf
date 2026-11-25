---
name: version
description: Adds major.minor versioning to the current repo, including monorepos (Turborepo, pnpm/npm/yarn/bun workspaces, Python packages, PHP/Composer apps and plugins) where every sub-package has its own version and the whole stack has one too. Installs a zero-dependency CLI that lists versions with ready-to-run bump commands; bumping sub-packages raises the stack minor once per command. Use when the user asks to add versioning, set up version numbers, bump a version, release a package, or list versions in a repo or monorepo.
---

# Versioning

Installs `scripts/version.mjs` into the target repo. `versions.json` at the repo root is the source of truth. Bumps are mirrored into each package's `package.json`, `pyproject.toml`, `composer.json` (PHP) or (for agent skills, i.e. directories with a `SKILL.md`) the `metadata.version` frontmatter field, as `major.minor.0`. For PHP apps the stack is also mirrored into a root `VERSION` file as plain `major.minor` (the file apps usually read themselves); the root `composer.json` is never written for the stack.

Rules the CLI enforces:
- Package `minor`: package `x.y` becomes `x.(y+1)`.
- Package `major`: package `x.y` becomes `(x+1).0`.
- One `bump` command may list several `<target> <part>` pairs. If it bumps any package, the stack minor goes up by 1 once for that command, not once per package. A later `bump` command is a new execution and raises it again.
- In the interactive list, the stack minor goes up once for the session, on the first package bump.
- The interactive list shows a `[ Commit changed files ]` button once something was bumped (in a git repo, not with `--dry-run`). Clicking it commits only the files the session's bumps changed (`versions.json` plus the synced manifests) as `Bump versions: <target> <from> -> <to>, ...`. Other staged or unstaged work is left alone. This is a user action in the terminal; agents still never commit unless asked.
- Stack `minor` or `major`: only the stack changes. If that same command also bumps packages, the explicit stack bump is the only stack change.
- Assigning a version records the local date in `since` (`YYYY-MM-DD`). `init` sets it on the stack and on every package it adds. `bump` sets it on every version that command changes, including the stack. `list` shows it. Entries from before this field have no date until the next bump. `since` is not copied into `package.json`, `pyproject.toml`, or `SKILL.md`.

## When invoked

Decide what to do from the user's message and from whether `versions.json` exists at the repo root:

| Situation | Action |
|-----------|--------|
| `/version` with no other request, and `versions.json` exists | The repo is already set up. Follow "Already set up" below: list the versions, then check whether the skill ships a newer CLI and update the repo's copy. Do not run setup again. |
| `/version` with no other request, and no `versions.json` | Follow the setup workflow below. |
| A specific request, such as "bump web minor" | Follow "Everyday use" below. |

To find the CLI, use the path in the root `package.json` `ver` script (or the older `version:list` script), falling back to `scripts/version.mjs`. If the repo has no copy, run `node <skill>/scripts/version.mjs list` and say the repo copy is missing.

## Already set up

When `/version` is run with no other request and `versions.json` exists, do these steps in order. Never run `init`, never bump, and never ask. `sync` is allowed only in step 3.

**1. List the versions.** Run the repo CLI's `list` command (always the explicit `list`, so output is static) and show its output verbatim in a code block. If it printed warnings, mention the suggested fix in one line.

**2. Get the latest CLI.** The skill's own copy may be stale, so refresh it first, then compare revisions. A revision is the integer printed by `--cli-version`; copies that predate the flag fail with `Unknown option`, which counts as `0`.

First refresh the skill. `<skill>` is often a symlink into a skills checkout, so resolve it and pull there (best effort: skip silently when it is not a git checkout, has no remote, is offline, or the pull is not a fast-forward; never stash, reset or commit):

```bash
git -C "$(cd <skill> && pwd -P)" pull --ff-only
```

Then find every copy of the CLI in the repo, not only the one the `ver` script runs. A repo may bundle another copy (for example `packages/*/assets/version.mjs` in a monorepo whose tool ships it):

```bash
git ls-files -z -- '*version.mjs' | xargs -0 grep -l "const CLI_VERSION" 2>/dev/null   # add -o --exclude-standard in a repo with untracked copies
node <copy> --cli-version                            # each repo copy (the one the ver script runs, plus any others found)
node <skill>/scripts/version.mjs --cli-version       # skill copy
```

Handle each repo copy separately:

| Result | Action |
|--------|--------|
| Skill revision is higher | Update that copy: `cp <skill>/scripts/version.mjs <copy>`. Keep its existing path, even if it is `tools/version.mjs`. Do not touch `versions.json` or any manifest. |
| Revisions are equal | Nothing to do. Say the CLI is current. |
| Copy's revision is higher | Do not overwrite. Say the copy is newer than the installed skill, so the skill may need updating (the pull above may have been skipped). |
| The repo has no copy of the CLI | Run the list with the skill's copy, then copy it to `scripts/version.mjs` as in setup step 2. |

**3. Check the wiring after an update.** Only when a CLI copy was just updated:
- Run `list` again with the updated CLI. If it shows new drift warnings, run `sync`, then `list` once more.
- If the root `package.json` has no `ver` script, or has a `scriptsInfo` field without a `ver` entry, add them as in setup step 5.

**4. Report.** One line on the outcome, for example "Updated the CLI from revision 1 to 2" or "CLI already current (revision 2)". Mention the interactive list only when the CLI was updated: plain `pnpm ver` in a terminal now opens clickable `[+]` bump buttons and a commit button for the bumped files. Do not commit.

## Setup workflow

Copy this checklist and track progress:

```
- [ ] 1. Check for an existing setup
- [ ] 2. Copy the CLI
- [ ] 3. Preview discovery and apply the decision rules
- [ ] 4. Create versions.json
- [ ] 5. Add package scripts or docs
- [ ] 6. Show the version list
- [ ] 7. Suggest an AGENTS.md rule
```

All commands run from the target repo root. `<skill>` is the directory containing this file.

**1. Check for an existing setup.** If `versions.json` already exists, the repo is set up. Skip to "Everyday use" below, and only re-run `init` to pick up new packages.

**2. Copy the CLI.** Copy it verbatim and do not rewrite it:

```bash
mkdir -p scripts && cp <skill>/scripts/version.mjs scripts/version.mjs
```

If `scripts/version.mjs` already exists and is not this CLI, do not overwrite it and do not ask. Use `tools/version.mjs` instead (or `scripts/ver.mjs` if `tools/` is unusual for the repo) and use that path everywhere below.

**3. Preview discovery.** Run:

```bash
node scripts/version.mjs init --dry-run
```

Read the discovered packages and seeds (a seed is the existing `major.minor` from the package manifest, or `0.1` when there is none). **Do not ask the user to confirm.** Apply the [decision rules](#decision-rules-do-not-ask) below, continue straight to step 4, and report what you chose in the final summary. Fix issues as follows:
- If a package is missing, it is outside the workspace globs or deeper than 3 levels. Add it to `versions.json` by hand after step 4 as `"path": { "version": "0.1", "type": "node" | "python" }`.
- If something should not be versioned, remove it from `versions.json` after step 4.
- If the user wants different starting versions, edit `versions.json` after step 4, then run `node scripts/version.mjs sync`.

**4. Create versions.json.** Run:

```bash
node scripts/version.mjs init
```

**5. Add a package script or docs.** If a root `package.json` exists, add this script and keep the existing ones:

```json
"ver": "node scripts/version.mjs"
```

`list` is the CLI's default command, so `pnpm ver` lists versions (interactively, with clickable `[+]` bump buttons, when run in a terminal) and `pnpm ver bump apps/web minor` bumps. With npm, use `npm run ver` and `npm run ver -- bump apps/web minor`. If a `ver` script already exists and runs something else, add the script as `versions` instead (and use that name in the summary). Do not ask.

If the root `package.json` has a `scriptsInfo` field (read by `pnpm ask`), also describe the script there under `Tools`, creating the group if needed: `"Tools": { "ver": "List versions and bump commands" }`.

If there is no root `package.json` (a Python-only or PHP-only repo), add a short "Versioning" section to the README with the `node scripts/version.mjs list` and `node scripts/version.mjs bump <target> <major|minor>` commands. Node >= 18 is required.

**6. Show the version list.** Run `node scripts/version.mjs list` and show the user the output. It prints exact bump commands for the repo's package manager, e.g. `pnpm ver bump apps/web minor`.

**7. Suggest an AGENTS.md rule.** Do not edit `AGENTS.md` and do not ask. Add a "Suggestion" at the end of the final summary offering to add this rule to the repo's `AGENTS.md` (or `CLAUDE.md` if that is what the repo uses; mention that `AGENTS.md` would be created if neither exists), so future agents keep versions current:

```markdown
## Versioning

When a change is made in a module (package), bump that module's minor version before finishing:
`<ver command> bump <module> minor`. Package bumps also raise the stack minor once per command, so pass every module changed in that one command. Use `major` only for breaking changes.
Never edit versions in manifests by hand.
```

Fill in `<ver command>` with the repo's real command (e.g. `pnpm ver`, or `node scripts/version.mjs`). Only write the rule if the user accepts the suggestion. If `AGENTS.md` already has a versioning rule, skip the suggestion.

## Decision rules (do not ask)

Setup must run start to finish without questions. Pick the default below, then state what you chose in the final summary so the user can change it. Every default can be undone by editing `versions.json` and running `sync`.

| Situation | Decision |
|-----------|----------|
| No `versions.json` | Run the full setup. Do not ask for permission to start. |
| Discovery finds packages with existing versions (e.g. `2.0`) | Keep them as seeds. `init` only reads native manifests and never rewrites them. |
| Packages have no version, or `0.0` | Accept the seed as-is. Do not ask for a different starting version. |
| Root has no version | Stack starts at the root manifest's `major.minor`, otherwise `0.1`. |
| Monorepo with apps, config and library packages | Version **every** discovered package, including apps, docs and config packages. The stack version is only meaningful if it covers all of them. Do not split into "published" and "unpublished". |
| A discovered package has `"private": true` | Still version it. |
| Package looks like an example, fixture, template or test app (under `examples/`, `fixtures/`, `templates/`, `e2e/`, `__tests__/`) | Version it anyway unless it is obviously a throwaway. Mention in the summary how to drop it from `versions.json`. |
| Repo uses **Changesets** (`.changeset/` directory) | Proceed. Do not touch `.changeset/` or its config. Say in the summary: `versions.json` owns `major.minor`; Changesets patch bumps are fine (`list` ignores patch). If Changesets bumps minor or major, record it with `bump <pkg> minor\|major` and run `sync`, or the next `list` will warn about drift. |
| Repo uses **semantic-release**, **release-please**, **lerna**, `npm version`, or similar | Proceed the same way. Mention in the summary that those tools will also write versions and can drift from `versions.json`. |
| Single-package repo (no workspaces, one root `package.json` or `pyproject.toml`) | Still set up. The root is the stack; `packages` may be empty. |
| Mixed Node and Python | Version both. `type` is detected per package. |
| Repo is a collection of agent skills (directories with `SKILL.md`) | Version every skill (`type: "skill"`). Each skill's `SKILL.md` frontmatter gets `metadata.version`. The root `package.json` is the stack manifest. |
| Python version is `dynamic`, or `setup.py` version is computed | Keep it in `versions.json`. The sync skip notice is expected: report it in one line and move on. |
| Package manager is unclear | Follow the CLI: `packageManager` field, then lockfile, then npm. Do not ask. |
| Root `package.json` exists | Add the `ver` script. Do not ask. |
| PHP/Composer app (root `composer.json`) | Version every directory with a `composer.json` (plugins, packages) as `type: "php"`; the root is the stack and keeps its version in the root `VERSION` file (seeded from it when present, created otherwise). Backup directories ending in `.old`, `.bak` or `.orig` are skipped. If the app already has its own version bump script, replace its body with a thin wrapper around the CLI instead of leaving two sources of truth. |
| Python-only or PHP-only repo (no root `package.json`) | Add the README "Versioning" section. Do not ask. |
| `README.md` does not exist and no `package.json` | Create a minimal `VERSIONING.md` with the commands instead. |
| Many packages (more than about 8) | Set up as usual. Do not feature any. Add a line to the summary suggesting `feature <package>` for the key ones, so they sit at the top of the list. |
| Dirty git working tree | Proceed. Setup only adds `scripts/version.mjs` and `versions.json` and edits the root `package.json` / README. |
| Git tags or commits | Do not commit or tag. Do not ask. |
| `AGENTS.md` (or `CLAUDE.md`) missing the versioning rule | Suggest the rule in the summary (setup step 7). Never write it unprompted. |
| `versions.json` already exists, plus new packages appeared | Run `init` (no `--prune`) to add them. |
| `versions.json` lists packages that no longer exist | Run `init --prune`. |
| `list` shows drift warnings after setup | Run `sync`, then `list` again. |
| Malformed `versions.json` | Tell the user which value is invalid and fix it only if the intent is obvious (e.g. `"1"` becomes `"1.0"`). |
| Node < 18 | Stop and tell the user. This is the only setup blocker. |

### Ask only when

Ask (with the question tool, one question, 2 to 3 options with a recommended default first) only if **all** are true:
1. The choice cannot be derived from the rules above, the repo, or the user's message.
2. The wrong choice would be hard to undo or would overwrite user work.

In practice this is rare: for example, two competing `versions.json`-like files that would both be authoritative, or a request that contradicts the rules (the user explicitly asked to exclude certain packages: do that without asking).

If the user's message states a preference ("only the published packages", "start at 1.0"), follow it over the defaults.

### Final summary format

End setup with the `list` output in a code block, followed by a short "Choices made" list. Example:

```
Choices made
- Versioned all 7 discovered packages (seeds from existing manifests; stack 0.1)
- Changesets detected: left as-is; it may bump patch freely, record minor/major bumps with `pnpm ver bump`
- Added "ver" script to package.json
To exclude a package: delete its entry in versions.json

Suggestion: add a "Versioning" rule to AGENTS.md so agents bump the minor version of the module they change
(`pnpm ver bump <module> minor`). Say "yes" and I'll add it.
```

## Everyday use

| Task | Command |
|------|---------|
| List versions and bump commands | `node scripts/version.mjs list` (static output; plain `pnpm ver` in a terminal opens a clickable list, so agents should use `list`) |
| Same, machine-readable | `node scripts/version.mjs list --json` |
| Bump a package | `node scripts/version.mjs bump <path-or-name> <major\|minor>` |
| Bump several packages (stack minor +1 once) | `node scripts/version.mjs bump <path> <part> [<path> <part> ...]` |
| Bump the stack only | `node scripts/version.mjs bump stack <major\|minor>` |
| Feature packages (list them first, after the stack) | `node scripts/version.mjs feature <path-or-name> [<path-or-name> ...]` |
| Remove packages from the featured list | `node scripts/version.mjs unfeature <path-or-name> [...]` |
| Preview any bump, feature or unfeature | add `--dry-run` |
| Pick up new packages | `node scripts/version.mjs init` (add `--prune` to drop deleted ones) |
| Fix native manifests that drifted | `node scripts/version.mjs sync` |

`<path-or-name>` accepts a package path (`apps/web`), a package name (`@acme/web`), or a unique directory name (`web`).

When the user asks to bump something:
1. Run `list --json` to resolve the target and see the current versions.
2. Pick `minor` for compatible changes and `major` for breaking changes. If the user did not say which, infer it from their wording and the changes (new features, fixes and refactors are `minor`; removed or renamed public APIs, config or CLI flags are `major`). Ask only if the changes contain both and the user gave no hint.
3. Run one `bump` command covering every package that should change. The stack minor increases once for that command. Report the before and after version of each package and of the stack.
4. Do not commit or tag unless the user asks. For tag naming, see [reference.md](reference.md).

Never edit versions in `package.json` or `pyproject.toml` by hand. Edit `versions.json`, or use `bump`, then run `sync`.

### Featured packages

In a repo with many packages the list gets long. `feature` puts the packages that matter on top: they are listed right after the stack row, in the order they were featured, marked with `★`, in the table, the bump commands and the interactive list. Everything else follows alphabetically. The order is stored in the top-level `featured` array of `versions.json`. Featuring changes no version: no `since`, no stack minor, no sync. Only feature packages when the user asks (or after setup, as a suggestion when there are more than about 8 packages); never choose them for the user. To reorder, `unfeature` then `feature` again. `list --json` has `featured: true|false` on each package. Needs CLI revision 8 or newer.

## Hooks (repo-specific sync and pre-commit)

The CLI only knows the manifests it syncs itself. Many repos hold the version somewhere else too (a Python `__version__` in `__init__.py`, a docs page, a Makefile) and guard it with a pre-commit hook such as `check-version-consistency`. A bump then leaves that file out of sync and out of the commit, and the commit is rejected. Hooks fix this: the repo declares commands under a `hooks` key in `versions.json`, and the CLI runs them.

```json
"hooks": {
  "postSync": ["python scripts/sync_init_versions.py"],
  "preCommit": ["pre-commit run --files {files}"]
}
```

| Event | Runs | Use it for |
|-------|------|------------|
| `postSync` | After `bump` and `sync` (and each bump click in the interactive list) wrote `versions.json` and the manifests | Updating the extra files that carry the version |
| `preCommit` | Before the commit button's `git add` / `git commit` | Formatters, or `pre-commit run --files {files}`, so the real commit passes |

Files a hook changes (found by diffing the git working tree) are reported and join the commit automatically; the hook needs no special output. Commands run from the repo root through the shell. `{files}` expands to the quoted pending files, and `VER_ROOT`, `VER_EVENT`, `VER_STACK`, `VER_CHANGES` (JSON) and `VER_FILES` are set. `--no-hooks` skips them for one run; `--dry-run` lists what would run.

When you meet a repo like that (a failed commit from a version-consistency check, or a version string the CLI does not update), do this:
1. Write a small script in the repo that reads `versions.json` and rewrites the extra file. Make it idempotent, and read the version from `versions.json`, not from the file.
2. Add it as a `postSync` hook. Add a `preCommit` hook only when the repo's pre-commit config reformats files.
3. Run `sync`, then `git status --short`, and check that the extra file shows as modified. Never hand-edit the version in the extra file.
4. The CLI copy must be revision 7 or newer (`--cli-version`). Update it as in "Already set up" if it is older. `/version` never edits `hooks` itself.

The interactive commit retries once when the repo's git hooks auto-fix files, and a failed commit now shows the tail of git's output (the failing hook is last), not just the first lines.

## Additional resources

- Manifest schema, discovery rules, sync behavior, hooks, and edge cases: [reference.md](reference.md)
