import { repoConfigPath } from '@pulpfixer/kit/config';
import type { Context } from '@pulpfixer/kit/context';
import { formatCmd, runCmd } from '@pulpfixer/kit/exec';
import { ACCOUNT_ID } from '@pulpfixer/kit/profiles';
import type { Command } from '@pulpfixer/kit/types';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick, type PickItem } from '@pulpfixer/kit/ui/picker';
import { ask, confirm } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, h2, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, splitDashes, takeFlag, takeOption, which } from '@pulpfixer/kit/util';
import {
  applyLink,
  candidateDetail,
  candidateLabel,
  describeDeployment,
  detectAwsDeployment,
  DEFAULT_SCOPES,
  linkChoices,
  projectAws,
  SCOPE_NAMES,
  whoami,
  type AwsDeployment,
  type LinkCandidate,
  type LinkChoices,
} from '@pulpfixer/plugin-aws';
import { startAgent } from '../agent/launch.js';

/**
 * `pf troubleshoot` (`pf t`): agent mode with a head start. pf first reads how the repo deploys and
 * which registered AWS profile it uses (linking one with a wizard when none applies), checks that
 * the credentials resolve to the pinned account, and only then starts the agent. From there pf is the
 * agent's bridge to AWS: read grants and fix actions are asked of the user, and pf runs every call.
 */

export const TROUBLESHOOT_USAGE = 'pf troubleshoot [what is wrong...] [--agent claude|codex|cursor] [--profile <name>] [--link] [--dry-run]';

function fail(message: string, code = 2): number {
  process.stderr.write(`${badgeLabel('error', err())} ${message}\n`);
  return code;
}

/** What the agent is asked first. The skill carries the method. */
export function troubleshootPrompt(prompt: string): string {
  const p = prompt.trim();
  return p
    ? `${p}\n\nThis is a troubleshooting session: call pf_skill with name "troubleshoot" and follow it, starting with pf_aws_context.`
    : 'This is a troubleshooting session: call pf_skill with name "troubleshoot" and follow it, starting with pf_aws_context. First ask me what is going wrong.';
}

/** What to do by hand when there is no terminal for the wizard: the best matches and the exact commands. */
export function linkHelp(choices: LinkChoices): string[] {
  const c = err();
  const lines = ['No pf profile applies to this repo, and there is no terminal to ask in.'];
  const best = choices.candidates.slice(0, 3);
  if (best.length) {
    lines.push('Best matches:');
    for (const x of best) lines.push(`  ${candidateLabel(x)}: ${candidateDetail(x)}`);
  } else {
    lines.push('pf has no profiles and ~/.aws/config lists none. Create one with `aws configure sso` first.');
  }
  const top = best[0];
  lines.push(
    'Run this in a terminal to pick one:',
    `  ${termLine('pf t --link', c)}`,
    'Or by hand:',
    `  ${termLine(`pf profile add <name> --aws-profile ${top?.awsProfile ?? '<aws-profile>'}${top?.account ? ` --account ${top.account}` : ' --account <id>'}${top?.region ? ` --region ${top.region}` : ''}`, c)}`,
    `  ${c.dim('then in this repo\'s pulpfixer.json:')} ${termLine('"profile": "<name>"', c)}`,
  );
  return lines;
}

/** Print what pf read about the deployment. */
function printDeployment(d: AwsDeployment): void {
  const c = err();
  process.stderr.write(`${h2('Deployment (read from this repo\'s files)', c)}\n`);
  for (const line of describeDeployment(d)) process.stderr.write(`  ${c.dim(line)}\n`);
}

const skip = Symbol('skip');
type Linked = { name: string; wroteRepo: boolean } | typeof skip | null;

/** Scopes to offer for a new profile: what the repo's services need, else pf's defaults. */
function suggestedScopes(d: AwsDeployment): string[] {
  const fit = d.suggestedScopes.filter((s) => SCOPE_NAMES.includes(s));
  return fit.length > 1 ? fit : DEFAULT_SCOPES;
}

/** Ask which profile this repo uses and link it. Null means cancelled. */
async function linkWizard(ctx: Context, d: AwsDeployment): Promise<Linked> {
  const c = err();
  const choices = linkChoices(ctx, d.hints);
  if (choices.candidates.length === 0) {
    process.stderr.write(`${badgeLabel('warning', c)} pf has no profiles and ~/.aws/config lists none. Create one with ${termLine('aws configure sso', c)}, then run ${termLine('pf t --link', c)}.\n`);
    return skip;
  }
  const matched = choices.candidates.filter((x) => x.score > 0).length;
  process.stderr.write(`${c.dim(matched ? `${matched} profile(s) match what this repo mentions.` : 'Nothing in the repo points at a profile, so every one is listed.')}\n`);
  const items: PickItem<LinkCandidate | typeof skip>[] = [
    ...choices.candidates.map((x) => ({
      value: x as LinkCandidate | typeof skip,
      label: candidateLabel(x),
      hint: x.account ?? 'account unknown',
      detail: candidateDetail(x),
    })),
    { value: skip, label: 'Continue without AWS access', hint: 'the agent still sees the repo' },
  ];
  const chosen = await pick('Which AWS profile does this repo use?', items);
  if (chosen === null) return null;
  if (chosen === skip) return skip;

  let extra: { account?: string; scopes?: string[] } = {};
  if (chosen.kind === 'aws') {
    process.stderr.write(`${c.dim(`${chosen.awsProfile} is not registered with pf yet. pf supports only registered profiles; this registers it (names only, nothing secret).`)}\n`);
    if (!chosen.account) {
      const account = await ask('Account id to pin (recommended)', {
        placeholder: '123456789012',
        ...(d.hints.accounts[0] ? { initial: d.hints.accounts[0] } : {}),
        validate: (v) => (!v || ACCOUNT_ID.test(v) ? null : '12 digits, or empty to skip'),
      });
      if (account === null) return null;
      if (account) extra = { ...extra, account };
    }
    const scopes = await ask(`Scopes the agent may be granted (${SCOPE_NAMES.join(', ')})`, {
      initial: suggestedScopes(d).join(','),
      validate: (v) => {
        const bad = v.split(',').map((s) => s.trim()).filter(Boolean).find((s) => !SCOPE_NAMES.includes(s));
        return bad ? `unknown scope "${bad}"` : null;
      },
    });
    if (scopes === null) return null;
    const list = scopes.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) extra = { ...extra, scopes: list };
  }
  const root = ctx.repo?.root ?? ctx.workdir;
  const yes = await confirm(`Link ${candidateLabel(chosen)} to ${repoConfigPath(root)}?`, true);
  if (!yes) return null;
  const linked = applyLink(ctx, chosen, extra);
  if (!linked.ok) {
    process.stderr.write(`${badgeLabel('error', c)} ${linked.reason}\n`);
    return null;
  }
  process.stderr.write(`${c.green('✓')} ${linked.registered ? `registered ${linked.name}, and ` : ''}${linked.wroteRepo ? `saved "profile": "${linked.name}" in pulpfixer.json` : `using ${linked.name} for this session (pulpfixer.json could not be written)`}\n`);
  if (linked.registered) {
    process.stderr.write(`${c.dim('Let the agent propose fixes (each approved one at a time) with')} ${termLine(`pf profile add ${linked.name} --actions "ecs update-service"`, c)}\n`);
  }
  return { name: linked.name, wroteRepo: linked.wroteRepo };
}

/** Run `aws sts get-caller-identity` through the profile. A number means stop with that exit code. */
async function checkCredentials(profileName: string, p: Extract<ReturnType<typeof projectAws>, { ok: true }>, dryRun: boolean): Promise<number | null> {
  const c = err();
  const target = p.target;
  if (dryRun) {
    const argv = ['aws', 'sts', 'get-caller-identity', '--output', 'json', '--profile', target.profile, ...(target.region ? ['--region', target.region] : [])];
    process.stderr.write(`${c.dim('would run')} ${termLine(formatCmd({ argv }), c)}\n`);
    return null;
  }
  if (!which('aws')) {
    process.stderr.write(`${badgeLabel('warning', c)} the aws CLI is not on PATH, so the agent cannot read AWS. Install the aws CLI v2.\n`);
    return null;
  }
  let w = await whoami(target, p.account);
  if (!w.ok && !/not the pinned account/.test(w.text) && /sso|expired|token|login/i.test(w.text) && interactive()) {
    const login = ['aws', 'sso', 'login', '--profile', target.profile];
    if (await confirm(`The AWS session looks expired. Run ${formatCmd({ argv: login })}?`, true)) {
      if ((await runCmd({ argv: login })) === 0) w = await whoami(target, p.account);
    }
  }
  if (w.ok) {
    process.stderr.write(`${c.green('✓')} ${profileName}: ${p.account ? `credentials resolve to the pinned account ${p.account}` : 'credentials work (the profile pins no account)'}\n`);
    return null;
  }
  if (/not the pinned account/.test(w.text)) {
    process.stderr.write(`${badgeLabel('error', c)} ${w.text.split('\n').slice(0, 2).join(' ')}\n${c.dim('Fix the AWS profile or log in again, then run')} ${termLine('pf t', c)}\n`);
    return 1;
  }
  process.stderr.write(`${badgeLabel('warning', c)} ${w.text.split('\n')[0]}\n${c.dim('The agent will not be able to read AWS until this works:')} ${termLine(`pf profile check ${profileName}`, c)}\n`);
  return null;
}

export const troubleshootCommand: Command = {
  name: 'troubleshoot',
  summary: 'Troubleshoot this repo\'s deployment with the agent and scoped AWS access',
  group: 'Agent',
  usage: TROUBLESHOOT_USAGE,
  async run(ctx, args) {
    const c = err();
    const [before, after] = splitDashes([...args]);
    const dryRun = takeFlag(before, '--dry-run', '-n');
    const linkOnly = takeFlag(before, '--link');
    const agent = takeOption(before, '--agent');
    let profile = takeOption(before, '--profile');
    const prompt = [...before, ...after].join(' ').trim();

    if (!ctx.repo) return fail(`pf t works inside a repo (this is ${ctx.cwd}). Go to the repo, or use ${termLine('pf agent', c)} anywhere.`);
    if (profile && !ctx.user.profiles?.[profile]) {
      return fail(`no profile named "${profile}". pf supports only registered profiles: list them with ${termLine('pf profile', c)} or link one with ${termLine('pf t --link', c)}.`);
    }

    const deployment = detectAwsDeployment(ctx);
    printDeployment(deployment);

    let p = projectAws(ctx, profile);
    if (!p.ok || linkOnly) {
      if (!p.ok) process.stderr.write(`${badgeLabel('info', c)} ${p.problem}\n`);
      if (dryRun) {
        process.stderr.write(`${c.dim('would ask which AWS profile this repo uses and link it (pulpfixer.json)')}\n`);
      } else if (!interactive()) {
        process.stderr.write(linkHelp(linkChoices(ctx, deployment.hints)).join('\n') + '\n');
        return 2;
      } else {
        const linked = await linkWizard(ctx, deployment);
        if (linked === null) {
          process.stderr.write(c.dim('cancelled, nothing linked\n'));
          return 130;
        }
        if (linked !== skip) {
          if (!linked.wroteRepo) profile = linked.name;
          p = projectAws(ctx, profile);
        }
      }
      if (linkOnly) return 0;
    }

    if (p.ok) {
      process.stderr.write(`${c.dim('profile')} ${p.profile.name} ${c.dim(`(from ${p.profile.source}) AWS profile ${p.target.profile}, account ${p.account ?? 'not pinned'}${p.target.region ? `, region ${p.target.region}` : ''}`)}\n`);
      const stop = await checkCredentials(p.profile.name, p, dryRun);
      if (stop !== null) return stop;
    } else if (!dryRun) {
      process.stderr.write(`${c.dim('no AWS profile: the agent can read the repo, and can ask you to link one with')} ${termLine('pf_aws_link_profile', c)}\n`);
    }

    return startAgent(ctx, {
      prompt: troubleshootPrompt(prompt),
      ...(agent !== undefined ? { agent } : {}),
      ...(profile ? { profile } : {}),
      dryRun,
      troubleshoot: { deployment: describeDeployment(deployment) },
    });
  },
};
