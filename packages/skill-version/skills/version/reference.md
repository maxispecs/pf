# Versioning reference

## versions.json

```json
{
  "stack": { "version": "1.4", "since": "2026-10-21" },
  "packages": {
    "apps/web": { "version": "2.1", "since": "2026-09-02", "type": "node" },
    "packages/ui": { "version": "0.7", "since": "2026-10-21", "type": "node" },
    "services/api": { "version": "1.0", "since": "2026-08-14", "type": "python" }
  }
}
```

- `stack.version` and every `packages[*].version` must match `^\d+\.\d+$`. The CLI refuses to run if any value is malformed.
- `since` is the local calendar date (`YYYY-MM-DD`) the current version was assigned. It is optional: versions assigned before the field existed omit it, and `list` prints `-` for those. A present value that is not a real calendar date is an error. `init` sets it on a new stack and on every package it adds, and leaves existing entries alone. `bump` sets it on every version that command changes, including the stack when a package bump raises it. A second bump of the same version on the same day keeps that date. `sync` does not write `since` into native manifests. If a version is edited by hand, update `since` too, or the list keeps the previous date.
- Keys under `packages` are repo-relative POSIX paths. The CLI sorts them on write.
- `type` is `node` (synced to `package.json`), `python` (synced to `pyproject.toml`, falling back to `setup.py`), `php` (synced to `composer.json`) or `skill` (synced to the `SKILL.md` frontmatter).
- `featured` (optional, top level) is an ordered array of package paths, for example `"featured": ["apps/web", "packages/ui"]`. Those packages are listed first, right after the stack row, in that order; the rest follow alphabetically. It must be an array of non-empty strings with no duplicates, or the CLI refuses to run. A path that is not in `packages` is not an error: `list` warns about it and ignores it for ordering, and `unfeature <path>` or `init --prune` removes it. The CLI writes `featured` right after `stack` and drops the key when it is empty. Use `feature` / `unfeature` to edit it (see below).
- `categories` (optional, top level) is an ordered object of category names, each `{ "color"?: "#rgb" | "#rrggbb" }`, for example `"categories": { "core": { "color": "#4aa3ff" }, "data": {} }`. Names have no leading or trailing spaces and no control characters; a malformed object or color makes the CLI refuse to run. A package's optional `"category"` is one of those names; a name that is not defined is a warning in `list` and counts as no category. The CLI writes `categories` right after `featured` (or `stack`) and drops the key when it is empty. Use `category` / `categorize` to edit it (see below).
- Unknown top-level keys, and unknown keys on an entry, are preserved. On bump, `version` and `since` are written first, then `type`, then any extra keys.

## Bump semantics

| Command | Package | Stack |
|---------|---------|-------|
| `bump <pkg> minor` | `x.y` becomes `x.(y+1)` | minor +1 |
| `bump <pkg> major` | `x.y` becomes `(x+1).0` | minor +1 |
| `bump <pkg> minor <pkg> major` | each listed package bumps once | minor +1 once |
| `bump <pkg> minor <pkg> minor` (same package twice) | that package bumps twice | minor +1 once |
| `bump stack minor` | unchanged | minor +1 |
| `bump stack major` | unchanged | `(x+1).0` |
| `bump <pkg> minor stack major` | package bumps | major only, no extra minor |

One `bump` command raises the stack minor once, however many packages it lists. A second command is a new execution and raises the stack minor again. The interactive list is one execution: the first package bump raises the stack minor, and later package bumps in that session do not. An explicit stack bump in the same command is the only stack change.

Every version a bump changes gets `since` set to the local date of that command. A dry run prints the date it would record and does not write it.

Write order: `versions.json` is written first, then native manifests. If a native write is skipped or fails, `versions.json` is still correct, and `sync` repairs the manifests.

## Featured packages (`feature`, `unfeature`)

| Command | Effect |
|---------|--------|
| `feature <target> [<target> ...]` | Appends each package to `featured`. Already featured packages keep their place. |
| `unfeature <target> [<target> ...]` | Removes each package from `featured`. |

Targets resolve like `bump` targets (path, package name, or unique directory name). `stack` is rejected. Only the `featured` key of `versions.json` is written: no version, `since`, stack bump, native manifest or hook is touched, and the commit button does not pick it up. `--dry-run` shows the result without writing. Bumping, `sync` and `init` keep `featured` as it is; `init --prune` also drops pruned paths from it.

Ordering is the same everywhere: `list`, the bump commands block, `list --json` (the `packages` array, each with `featured`) and the interactive list. The stack is always first. Once any package is featured, the TARGET column gets a 2 character lead on every row: `★ ` for featured packages and blanks for the others, so names stay aligned. Bump commands and JSON paths stay plain.

## Categories (`category`, `categorize`)

| Command | Effect |
|---------|--------|
| `category` | Lists the categories with their color and package count. |
| `category <name> [--color <#hex\|none>]` | Creates the category (appended, so it lists last), or changes its color; `--color none` clears it. |
| `category <name> --remove` | Deletes the category and clears `category` on its packages. |
| `categorize <category> <target> [<target> ...]` | Sets `category` on each package. The category must exist. |
| `categorize --none <target> [<target> ...]` | Removes `category` from each package. |

Targets resolve like `bump` targets; `stack` is rejected. Only `categories` and the packages' `category` key are written: no version, `since`, stack bump, native manifest or hook, and the commit button does not pick it up (`init`, `sync` and bumps keep them). To reorder categories, edit the order of the keys in `versions.json`. `--dry-run` shows the result without writing.

Order in `list`, the bump commands block, `list --json` (`packages` array, each with `category`; top-level `categories` is `[{ name, color }]` in order) and the interactive list: the stack, then the featured packages (whatever their category, in featured order), then one group per category in the `categories` order (alphabetical inside), then the packages with no category. `list` shows a CATEGORY column (last) only when categories exist and paints a package's target in its category's color (24-bit color when `COLORTERM` says so, else the 256-color cube; `NO_COLOR` turns it off). The interactive list draws a `-- <category>` header before each group.

## Discovery (`init`, and drift warnings in `list`)

Node packages come from workspace globs, read from the root `package.json` `workspaces` field (array or `{ "packages": [...] }`) and from `pnpm-workspace.yaml` `packages:`. The globs support `*`, `?`, `**` and `!negation`. A matched directory counts only if it contains a `package.json`. `turbo.json` is detected and shown, but it is not a source of packages, because Turborepo relies on the package manager's workspaces.

Python packages are any directory, up to 3 levels deep, that contains `pyproject.toml` or `setup.py`. The search does not descend into a found Python package or into a Node workspace package.

PHP packages are any directory, up to 3 levels deep, that contains `composer.json` and is not already a Node, Python or skill package. The search does not descend into a found PHP package. `vendor` is skipped like the other dependency directories.

Agent skills are any directory, up to 3 levels deep, that contains a `SKILL.md`. The search does not descend into a found skill. A directory that is both a Node workspace package and a skill is versioned as `node`.

Directories starting with `.`, directories ending in `.old`, `.bak` or `.orig`, and `node_modules`, `dist`, `build`, `out`, `coverage`, `venv`, `env`, `__pycache__`, `site-packages`, `target` and `vendor` are always skipped.

The root directory is never a package. Its `package.json`, `pyproject.toml` and `VERSION` file are the stack's native manifests.

Packages added to `versions.json` by hand are kept even when discovery does not find them, as long as the directory exists.

## Native sync

| File | Field written | Notes |
|------|---------------|-------|
| `package.json` | top-level `"version"` | Edited in place, keeping formatting. If missing, inserted after `"name"`. |
| `pyproject.toml` | `version` under `[project]` and/or `[tool.poetry]` | Line edit that keeps quotes and trailing comments. Skipped with a notice if the version is `dynamic` or absent. |
| `setup.py` | first literal `version="..."` | Skipped with a notice if the version is computed. |

| `composer.json` | top-level `"version"` | Edited in place, keeping formatting. If missing, inserted after `"name"`. Written as `major.minor.0`. Composer's own tooling prefers tag-derived versions for packages published on Packagist: drop the field and rely on tags for those. |
| `VERSION` (root only) | whole file | Stack only. Written as `major.minor` plus a newline, matching what PHP apps read. Used when the file exists, or when the repo has a root `composer.json` and no `package.json`. |
| `SKILL.md` | `metadata.version` in the YAML frontmatter | Edited in place. The `metadata:` block and the `version` line are added if missing. Skipped with a notice if there is no frontmatter. |

The stack is synced to the root `package.json`, which gets a `version` field added if it has none. It is also synced to the root `VERSION` file (see above); the root `composer.json` is not written. It is also synced to the root `pyproject.toml`, but only when that file already has a static version. A uv or Poetry workspace root without one is left alone.

The native value is always `major.minor.0`. `list` warns only when the native `major.minor` differs from `versions.json`, so patch numbers set by other tools do not cause warnings.

## Hooks

`versions.json` may carry a top-level `hooks` object. Each key is an event and each value a shell command or an array of commands, run in order from the repo root.

```json
{
  "stack": { "version": "1.1", "since": "2026-11-16" },
  "packages": { "packages/core": { "version": "3.2", "since": "2026-11-16", "type": "python" } },
  "hooks": {
    "postSync": ["python scripts/sync_init_versions.py"],
    "preCommit": ["pre-commit run --files {files}"]
  }
}
```

| Event | When | Notes |
|-------|------|-------|
| `postSync` | At the end of `bump` and `sync`, and after each bump click in the interactive list | Runs even when `sync` changed nothing, so it can repair files the CLI does not know about. Not run with `--dry-run` (the commands are listed as `would run`), and never by `list` or `init`. |
| `preCommit` | In the interactive commit button, before `git add` and `git commit` | Receives the pending files. Files it changes are added to the commit. |

An unknown event name, or a value that is not a string or an array of non-empty strings, is an error when `versions.json` loads, so typos surface at once.

Every command gets:
- `{files}` replaced by the shell-quoted list of pending files (including files earlier hooks changed).
- `VER_ROOT` (repo root), `VER_EVENT`, `VER_STACK` (the stack `major.minor` after the bump), `VER_CHANGES` (JSON array of `[target, from, to]`; `[]` for `sync`) and `VER_FILES` (newline-separated pending files).

Changed files are detected by hashing the git-dirty files (`git status --porcelain`) before and after each command. Any file whose content differs afterwards, or which became dirty, is reported as `changed by hook` and added to the pending commit set (`recordPending`), next to `versions.json` and the synced manifests. Outside a git repo the hooks still run, but nothing is detected. Files outside the repo root are ignored.

A command that exits non-zero stops the run and shows its output (the last 20 lines). For `postSync`, `versions.json` and the manifests are already written, so fix the hook and run `sync` to repeat it. In the interactive list the bump is still recorded as pending and the error is printed on exit.

`--no-hooks` skips all hooks for one run, including the commit button's.

### Commit button and the repo's git hooks

The commit button runs `preCommit` hooks, stages and commits the pending files, and:
- If `git commit` fails and the pending files changed on disk during the attempt (pre-commit auto-fixed whitespace, black, ruff), it stages them again and retries once.
- A commit that still fails raises an error with the last 20 lines of git's output. The failing hook is printed last; the first lines are always the hooks that passed.

### Recipe: Python `__version__` guarded by pre-commit

```python
# scripts/sync_init_versions.py
import json, re
packages = json.load(open("versions.json"))["packages"]
for path, key in {"packages/core/panagent_core/__init__.py": "packages/core"}.items():
    text = open(path).read()
    open(path, "w").write(re.sub(r'__version__\s*=\s*"[^"]*"', f'__version__ = "{packages[key]["version"]}"', text))
```

Add `"hooks": { "postSync": ["python scripts/sync_init_versions.py"] }`. Then `bump` and `sync` update `__init__.py`, and the commit button includes it, so a `check-version-consistency` pre-commit hook passes.

## Bump command display

`list` prints commands that match the repo:

| Condition | Prefix |
|-----------|--------|
| Root `package.json` has a `ver` script that runs `version.mjs`, with pnpm | `pnpm ver bump` |
| Same, with yarn | `yarn ver bump` |
| Same, with bun | `bun run ver bump` |
| Same, with npm or unknown | `npm run ver -- bump` |
| Only the older `version:bump` script exists | `pnpm version:bump` (or the equivalent for yarn, bun or npm) |
| Neither script exists | `node scripts/version.mjs bump` |

`list` adds a SINCE column, the `since` date or `-` when the version has none. `--json` includes `since` on the stack and on each package, with `null` when it is absent.

`pnpm ver` with no arguments runs `list`, the default command. In a real terminal it opens an interactive list instead: click `[+]` before a version to bump major, after it to bump minor (hovering previews the new version, including the one stack minor a package bump would add), and press any key, or click the "Press any key to exit" line (it highlights on hover), to exit. After a bump, a `[ Commit changed files ]` button appears (git repos only, hidden with `--dry-run`); hovering shows the message and file count. Clicking it runs `git add` and `git commit` limited to the files the session's bumps changed (`versions.json` and each manifest that was actually rewritten, skipping git-ignored ones), with the message `Bump versions: <target> <from> -> <to>, ...`. Other staged or unstaged changes are not included, and files with their own unrelated edits are committed whole. Bumps made after a commit start a new pending set; anything uncommitted at exit is listed as `not committed: ...`. The stack minor rises once for that session, on the first package bump. The SINCE column is in that list too. Without a terminal (pipes, CI, agent shells), with `--json`, or with an explicit `list`, it prints the static list.

The package manager is taken from `packageManager` in the root `package.json`, otherwise from the lockfile.

Output is colored when stdout is a terminal. `NO_COLOR=1` turns colors off and `FORCE_COLOR=1` forces them on. `--json` output is never colored. Agent shells usually set `NO_COLOR`, so agents see plain text, but they should still use `list --json` when they need to parse the output.

## CLI revision

`version.mjs --cli-version` prints the CLI's integer revision (the `CLI_VERSION` constant). Bump it whenever the script changes, so `/version` on an already set-up repo can tell that the repo's copy is older than the skill's and update it. Copies from before the flag existed fail with `Unknown option` and count as revision 0.

## Git tags (optional, manual)

The CLI never tags, and only commits when the user clicks the interactive commit button. If the user wants tags after a bump, use this convention:

```bash
git add -A && git commit -m "release: apps/web 2.2, stack 1.5"
git tag stack-v1.5
git tag apps/web-v2.2
```

Tag the stack on every bump, and tag the package only when a package was bumped.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `No versions.json found` | Run from inside the repo, or pass `--root <dir>`. Run `init` if the repo was never set up. |
| `"web" is ambiguous` | Use the full package path from `list`. |
| A package is not discovered | It is outside the workspace globs or more than 3 levels deep. Add it to `versions.json` by hand. |
| `skipped ... (version is dynamic)` | The Python version comes from a tool such as hatch-vcs or setuptools-scm. `versions.json` is still authoritative. Point the tool at it or accept the skip. |
| A package is literally named `stack` | Target it as `./stack`. A bare `stack` always means the whole stack. |
| A version file the CLI does not know is out of date after a bump (for example a Python `__init__.py`) | Add a `postSync` hook that rewrites it (see Hooks), then run `sync` and `git status --short`. |
| `git commit failed` from the commit button | Read the whole error: the failing git hook is the last one listed. Fix the cause, or run the hooks yourself with `pre-commit run --all-files`, then commit again. |
| `PermissionError: Operation not permitted` from pre-commit or git | You are in a restricted shell, such as an agent sandbox. Run the commit or the hook in a normal terminal. |
| `Unknown hook "..."` or `Invalid hooks.<event>` | Fix the `hooks` key in `versions.json`: events are `postSync` and `preCommit`, values are strings or arrays of strings. |
