---
name: fix-failing
description: Get a failing test or build green. Use when tests fail, the build breaks, or the user asks to fix the repo.
---

# Fix a failing check

1. Call `pf_commands` so you run the repo's own check, not a guessed one.
2. Run the failing task with `pf_run` (`test` unless the user said the build or the linter). Read the tail of the output.
3. Change only what the failure points at. Do not tidy unrelated code.
4. Run the same task again with `pf_run`. Repeat until it exits 0 or you are blocked on something only the user knows.
5. When the check is green and a module changed, call `pf_bump` with `minor`.
