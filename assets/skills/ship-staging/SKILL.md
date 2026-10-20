---
name: ship-staging
description: Check the repo, bump its version and deploy to staging. Use when the user wants to ship, release or deploy. Production is never a target.
---

# Ship to staging

1. Call `pf_commands` and run `test` and `build` with `pf_run` when this repo has them. Stop if either fails.
2. Call `pf_versions`. If versioning is set up and a module changed, call `pf_bump` with `minor` (or `major` when the user asked for a breaking bump). Never edit a version by hand.
3. Call `pf_deploy_staging` without `confirm`. Show the plan to the user, including every skipped target.
4. Call `pf_deploy_staging` with `confirm: true` only after the user agrees. If a step fails, stop and report that step.
