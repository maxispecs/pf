---
name: troubleshoot
description: Find out why a deployed service is failing or unhealthy on AWS, using pf as the bridge to AWS. Use when the user reports an outage, errors after a deploy, unhealthy tasks or instances, or runs pf t. Reads first, and changes AWS only with the user's approval of each action.
---

# Troubleshoot a deployment on AWS

You never get AWS credentials and never run the `aws` CLI yourself. Every AWS call goes through pf, which checks it against what the user approved.

## 1. Get oriented

1. Call `pf_aws_context`. It says how this repo deploys (staging and production commands, accounts, regions, clusters, services, functions, log groups), which pf profile applies, which scopes to request, and which fix actions the user enabled.
2. If it says no profile applies, call `pf_aws_link_profile`. The user picks the profile in a dialog. If they decline, stop asking for AWS and work from the repo alone.
3. Ask the user what is wrong if they have not said: which service, which symptom, since when. One question is enough.

## 2. Read, with the least access

1. Call `pf_aws_request_access` with only the scopes the symptom needs and a one-line reason. Start from the scopes `pf_aws_context` suggests, and skip the rest.
   - Tasks restarting, 502/503, bad deploy: `ecs`, `elb`, `cloudwatch`, then `logs` if allowed.
   - Function errors or timeouts: `lambda-metadata`, `cloudwatch`, `logs`.
   - A stack that failed to update: `cloudformation`.
   - Instance or autoscaling trouble: `ec2`, `elb`, `cloudwatch`, `ssm-metadata`.
   - Database trouble: `rds`, `cloudwatch`.
2. If the user declines, do not ask again unless they tell you to.
3. Call `pf_aws_whoami` once and check that the account is the one the repo deploys to. If pf reports a mismatch, stop and tell the user.
4. Work with `pf_aws_describe`, narrowing every call (`query`, `filters`, `max-items`, a short time range). Pf redacts secret-looking values; do not try to get around that.

## 3. Find the cause

- Start where the symptom shows: service events and desired versus running counts, target health, recent alarms, then logs around the time it began.
- Compare with the last deploy: what the repo's staging or production command does (from `pf_aws_context`), the task definition revision and image tag now running, and the git history (`git log`) of the repo for what changed.
- Keep a short list of what you checked and ruled out. Say what you saw, not what you assume.
- Stop reading when you can explain the failure with evidence. Do not keep requesting more scopes to be thorough.

## 4. Report, then propose a fix

1. Tell the user: the symptom, the cause with the evidence (resource names, timestamps, messages), and how sure you are.
2. If the fix is in the repo (config, code, a bad image tag), make it with the repo tools and `pf_run`, and leave deploys to the user or `pf_deploy_staging`. Production is never a target.
3. If the fix is a change on AWS and `pf_aws_context` lists a matching enabled action, say exactly what you would run and why, and wait for the user to agree.
4. Only then call `pf_aws_act` with the narrowest params and a reason that states the evidence. pf shows the user the exact command and runs it only if they approve that one call.
   - A declined action is final: offer another approach, never retry it.
   - If the action is not enabled, tell the user the command to enable it (`pf profile add <name> --actions "<service> <operation>"`) or to run the change themselves. Do not look for another way in.
5. After an approved action, check the result with `pf_aws_describe` (for example the service reaching steady state) and report it.

## Rules

- Prefer the smallest change that fixes the cause: a redeploy before a rescale, a rescale before anything else.
- Never ask for, print or store credentials, tokens or secret values, and do not paste log lines that contain them.
- Finish with what is fixed, what is not, and what the user should watch.
