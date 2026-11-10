import { objectSchema, type Tool, type ToolResult, type ToolSession } from '@pulpfixer/kit/agent-tool';
import type { Context } from '@pulpfixer/kit/context';
import { formatCmd } from '@pulpfixer/kit/exec';
import { ACTIONS, actionKey, checkAction, checkOperation, DEFAULT_TTL, paramArgv, redactJson, redactText, SCOPE_NAMES, scopeOf } from './access.js';
import { awsRun, callArgv, whoamiArgv, type AwsTarget } from './aws.js';
import { activeGrant, markVerified, minutesLeft, saveGrant, type Grant } from './grants.js';
import { describeDeployment, detectAwsDeployment } from './infra.js';
import { applyLink, candidateDetail, candidateLabel, linkChoices } from './link.js';
import { describeLimits, projectAws } from './project.js';

const fail = (text: string): ToolResult => ({ ok: false, text });
const MAX_TEXT = 30_000;

const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : undefined);

function scopeLines(names: string[]): string[] {
  return names.map((n) => {
    const s = scopeOf(n)!;
    const ops = Object.entries(s.ops).map(([svc, list]) => `${svc}: ${list.join(', ')}`).join('; ');
    return `- ${s.name} (${s.summary}): ${ops}`;
  });
}

function grantLine(g: Grant): string {
  return `active grant: scopes ${g.scopes.join(', ')}; regions ${g.regions ? g.regions.join(', ') : 'any'}; ${minutesLeft(g)} min left; approved by ${g.approvedBy === 'dialog' ? 'the user in pf\'s dialog' : 'the user in the agent CLI\'s prompt'}`;
}

/** Shorten long output from the front, so the agent still sees valid-looking JSON and a note. */
function clip(text: string, cut: boolean): string {
  if (text.length <= MAX_TEXT && !cut) return text;
  return `${text.slice(0, MAX_TEXT)}\n[output cut by pf: narrow the call with --query, --filters, --max-items or a smaller time range]`;
}

/** The session's live grant for the profile that applies here, or why the call cannot run. */
function needGrant(ctx: Context, session: ToolSession | undefined): { ok: true; grant: Grant; target: AwsTarget & { profile: string }; account?: string } | { ok: false; result: ToolResult } {
  const p = projectAws(ctx);
  if (!p.ok) return { ok: false, result: fail(p.problem) };
  const grant = session ? activeGrant(session.id, p.profile.name) : undefined;
  if (!grant) return { ok: false, result: fail(`No live AWS grant for profile "${p.profile.name}". Call pf_aws_request_access with the scopes you need and a reason; the user approves it.`) };
  return { ok: true, grant, target: p.target, ...(p.account ? { account: p.account } : {}) };
}

/** `sts get-caller-identity`, checked against the pinned account. */
export async function whoami(target: AwsTarget, pinned: string | undefined): Promise<{ ok: boolean; text: string; account?: string }> {
  const r = await awsRun(whoamiArgv(target), { timeout: 30_000 });
  if (!r.ok) return { ok: false, text: `aws sts get-caller-identity failed${r.timedOut ? ' (timed out)' : ''}:\n${redactText(r.stderr)}` };
  let id: { Account?: string; Arn?: string; UserId?: string };
  try {
    id = JSON.parse(r.stdout) as typeof id;
  } catch {
    return { ok: false, text: 'unexpected output from aws sts get-caller-identity' };
  }
  const lines = [`account: ${id.Account ?? '?'}`, `arn: ${id.Arn ?? '?'}`];
  if (pinned && id.Account !== pinned) {
    return { ok: false, text: [...lines, `This is not the pinned account ${pinned}. pf refuses to read anything with these credentials; the user should fix the AWS profile.`].join('\n'), ...(id.Account ? { account: id.Account } : {}) };
  }
  if (!pinned) lines.push('note: the profile pins no account, so pf cannot check which account this is meant to be.');
  return { ok: true, text: lines.join('\n'), ...(id.Account ? { account: id.Account } : {}) };
}

/** Check the account once per grant before the first read. */
async function ensureVerified(session: ToolSession, grant: Grant, target: AwsTarget, pinned: string | undefined): Promise<ToolResult | null> {
  if (grant.verified || !pinned) return null;
  const w = await whoami(target, pinned);
  if (!w.ok) {
    session.audit({ event: 'aws-account-mismatch', profile: grant.profile, expected: pinned, got: w.account });
    return fail(w.text);
  }
  markVerified(session.id, grant.profile);
  return null;
}

const profileTool: Tool = {
  name: 'pf_aws_profile',
  description:
    'Show the pf profile for this repo: AWS profile, pinned account, region, the most you may be granted, your live grant, and every read-only AWS operation pf allows by scope. Call this before any AWS troubleshooting.',
  inputSchema: objectSchema(),
  readOnly: true,
  async run(ctx, _input, session) {
    const p = projectAws(ctx);
    if (!p.ok) return fail(p.problem);
    const grant = session ? activeGrant(session.id, p.profile.name) : undefined;
    return {
      ok: true,
      text: [
        `pf profile: ${p.profile.name} (from ${p.profile.source})`,
        `AWS profile: ${p.target.profile}`,
        `account: ${p.account ? `${p.account} (pinned)` : 'not pinned'}`,
        `region: ${p.target.region ?? 'from the AWS profile'}`,
        `limits: ${describeLimits(p.limits)}`,
        grant ? grantLine(grant) : 'grant: none. Call pf_aws_request_access with the scopes you need and why.',
        '',
        'Operations by scope (pf_aws_describe accepts only these):',
        ...scopeLines(SCOPE_NAMES),
        '',
        'You never get credentials: pf runs each call itself and checks it against the grant. Secret-looking values are redacted.',
      ].join('\n'),
    };
  },
};

const requestTool: Tool = {
  name: 'pf_aws_request_access',
  description:
    'Ask the user for time-limited, read-only AWS access for this session. pf shows them a dialog with the profile, account, scopes, regions and your reason; nothing is granted unless they approve. Ask for the fewest scopes the task needs.',
  inputSchema: objectSchema(
    {
      scopes: { type: 'array', items: { type: 'string', enum: SCOPE_NAMES }, description: 'Scopes to read (see pf_aws_profile). identity is always included.' },
      regions: { type: 'array', items: { type: 'string' }, description: 'Regions to read. Defaults to the profile\'s.' },
      ttlMinutes: { type: 'integer', minimum: 1, description: `How long the grant lasts. Default ${DEFAULT_TTL}, capped by the profile.` },
      reason: { type: 'string', description: 'What you are troubleshooting, shown to the user.' },
    },
    ['scopes', 'reason'],
  ),
  readOnly: false,
  asksUser: true,
  async run(ctx, input, session) {
    const p = projectAws(ctx);
    if (!p.ok) return fail(p.problem);
    if (!session) return fail('pf cannot ask the user outside an MCP session.');
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!reason) return fail('reason is required: say what you are troubleshooting.');
    const asked = strList(input.scopes) ?? [];
    const unknown = asked.filter((s) => !SCOPE_NAMES.includes(s));
    if (unknown.length) return fail(`Unknown scope(s): ${unknown.join(', ')}. Scopes: ${SCOPE_NAMES.join(', ')}.`);
    const beyond = asked.filter((s) => !p.limits.scopes.includes(s));
    if (beyond.length) {
      return fail(`The profile "${p.profile.name}" does not allow ${beyond.join(', ')} (allowed: ${p.limits.scopes.join(', ') || 'none'}). Only the user can widen that, with pf profile add ${p.profile.name} --scopes ...`);
    }
    const scopes = [...new Set(['identity', ...asked])].filter((s) => p.limits.scopes.includes(s));
    const askedRegions = strList(input.regions);
    let regions: string[] | null;
    if (askedRegions) {
      const outside = p.limits.regions ? askedRegions.filter((r) => !p.limits.regions!.includes(r)) : [];
      if (outside.length) return fail(`Region(s) ${outside.join(', ')} are outside the profile's limits (${p.limits.regions!.join(', ')}).`);
      regions = askedRegions;
    } else {
      regions = p.limits.regions ?? (p.target.region ? [p.target.region] : null);
    }
    const askedTtl = typeof input.ttlMinutes === 'number' && input.ttlMinutes > 0 ? Math.floor(input.ttlMinutes) : DEFAULT_TTL;
    const ttl = Math.min(askedTtl, p.limits.maxTtlMinutes);

    const summary = [
      'The agent asks pulpfixer for read-only AWS access.',
      `Profile: ${p.profile.name} (from ${p.profile.source}), AWS profile ${p.target.profile}, account ${p.account ?? 'not pinned'}`,
      `Scopes: ${scopes.join(', ')}`,
      `Regions: ${regions ? regions.join(', ') : 'any'}`,
      `For: ${ttl} minutes`,
      `Reason: ${reason}`,
      'The agent never sees credentials. pf runs each call and refuses anything outside this grant.',
    ].join('\n');
    session.audit({ event: 'aws-request', profile: p.profile.name, scopes, regions, ttlMinutes: ttl, reason });

    let approvedBy: Grant['approvedBy'];
    if (session.elicit) {
      let answer;
      try {
        answer = await session.elicit(summary, {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Grant this access', description: `Read-only, ${ttl} minutes, this session only`, default: false } },
          required: ['approve'],
        });
      } catch (e) {
        session.audit({ event: 'aws-decision', profile: p.profile.name, approved: false, error: e instanceof Error ? e.message : String(e) });
        return fail(`pf could not show the approval dialog: ${e instanceof Error ? e.message : String(e)}`);
      }
      const approved = answer.action === 'accept' && answer.content?.approve === true;
      session.audit({ event: 'aws-decision', profile: p.profile.name, approved, action: answer.action });
      if (!approved) return fail('The user did not approve AWS access. Do not ask again unless they tell you to; continue without AWS or explain what you would need.');
      approvedBy = 'dialog';
    } else if (session.trustClientPrompt) {
      approvedBy = 'agent-cli-prompt';
      session.audit({ event: 'aws-decision', profile: p.profile.name, approved: true, by: approvedBy });
    } else {
      session.audit({ event: 'aws-decision', profile: p.profile.name, approved: false, error: 'no elicitation' });
      return fail('pf could not ask the user: this agent CLI does not show MCP elicitation dialogs, and this session does not accept another approval. Ask the user to update the agent CLI.');
    }

    const now = Date.now();
    const grant: Grant = {
      session: session.id,
      pid: process.pid,
      profile: p.profile.name,
      awsProfile: p.target.profile,
      ...(p.account ? { account: p.account } : {}),
      scopes,
      regions,
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 60_000).toISOString(),
      reason,
      approvedBy,
    };
    if (!saveGrant(grant, now)) return fail('The user approved, but pf could not record the grant (~/.pf is not writable).');
    return { ok: true, text: `Granted. ${grantLine(grant)}\nUse pf_aws_whoami to confirm the account, then pf_aws_describe.` };
  },
};

const whoamiTool: Tool = {
  name: 'pf_aws_whoami',
  description: 'Which AWS account and identity the profile resolves to (sts get-caller-identity), checked against the pinned account. Needs a live grant.',
  inputSchema: objectSchema(),
  readOnly: true,
  async run(ctx, _input, session) {
    const g = needGrant(ctx, session);
    if (!g.ok) return g.result;
    const w = await whoami(g.target, g.account);
    if (w.ok && g.account) markVerified(session!.id, g.grant.profile);
    if (!w.ok && g.account && w.account) session!.audit({ event: 'aws-account-mismatch', profile: g.grant.profile, expected: g.account, got: w.account });
    return { ok: w.ok, text: w.text };
  },
};

const describeTool: Tool = {
  name: 'pf_aws_describe',
  description:
    'Run one read-only AWS CLI call that the live grant allows, e.g. service "ecs", operation "describe-services", params { "cluster": "web", "services": ["api"] }. Params are CLI flags without the dashes; true adds a bare flag. pf sets --profile, --region and --output itself. Returns JSON with secret-looking values redacted.',
  inputSchema: objectSchema(
    {
      service: { type: 'string', description: 'AWS CLI service, e.g. ec2, ecs, logs, elbv2' },
      operation: { type: 'string', description: 'Operation, e.g. describe-instances' },
      params: { type: 'object', description: 'Flag -> value (string, number, true, or a list of strings)', additionalProperties: true },
      region: { type: 'string', description: 'Region, when the grant has more than one. Defaults to the profile\'s.' },
    },
    ['service', 'operation'],
  ),
  readOnly: true,
  async run(ctx, input, session) {
    const g = needGrant(ctx, session);
    if (!g.ok) return g.result;
    const service = typeof input.service === 'string' ? input.service.trim() : '';
    const operation = typeof input.operation === 'string' ? input.operation.trim() : '';
    if (!service || !operation) return fail('service and operation are required');
    const op = checkOperation(service, operation, g.grant.scopes);
    if (!op.ok) {
      session!.audit({ event: 'aws-refused', service, operation, reason: op.reason });
      return fail(op.reason);
    }
    const params = paramArgv(input.params);
    if (!params.ok) return fail(params.reason);
    const asked = typeof input.region === 'string' && input.region.trim() ? input.region.trim() : undefined;
    const fallback = g.target.region && (!g.grant.regions || g.grant.regions.includes(g.target.region)) ? g.target.region : g.grant.regions?.[0];
    const region = asked ?? fallback;
    if (g.grant.regions && (!region || !g.grant.regions.includes(region))) {
      return fail(`Region ${region ?? '(none)'} is outside the grant (${g.grant.regions.join(', ')}).`);
    }
    const target: AwsTarget = { profile: g.target.profile, ...(region ? { region } : {}) };
    const unverified = await ensureVerified(session!, g.grant, target, g.account);
    if (unverified) return unverified;

    const argv = callArgv(service, operation, params.argv, target);
    const r = await awsRun(argv);
    session!.audit({ event: 'aws-call', service, operation, region, ok: r.ok });
    if (!r.ok) return fail(`aws ${service} ${operation} failed${r.timedOut ? ' (timed out)' : ''}:\n${redactText(r.stderr).slice(0, 4000)}`);
    let text: string;
    try {
      text = r.stdout.trim() ? JSON.stringify(redactJson(JSON.parse(r.stdout)), null, 1) : '(no output)';
    } catch {
      text = r.stdout;
    }
    return { ok: true, text: clip(redactText(text), r.truncated) };
  },
};

const contextTool: Tool = {
  name: 'pf_aws_context',
  description:
    'How this repo deploys (stack, staging and production deploy commands, AWS accounts, regions, clusters, services, functions and log groups read from its files), which pf profile applies, and which scopes and fix actions fit. Local only: it calls nothing on AWS. Call this first when troubleshooting.',
  inputSchema: objectSchema(),
  readOnly: true,
  async run(ctx) {
    const d = detectAwsDeployment(ctx);
    const p = projectAws(ctx);
    const lines = ['Deployment (read from the repo\'s files; hints, not facts):', ...describeDeployment(d).map((l) => `- ${l}`), ''];
    if (!p.ok) {
      lines.push(`pf profile: none. ${p.problem}`, 'Call pf_aws_link_profile: the user picks a profile pf supports in a dialog, and pf links it to this repo.');
      return { ok: true, text: lines.join('\n') };
    }
    lines.push(
      `pf profile: ${p.profile.name} (from ${p.profile.source}), AWS profile ${p.target.profile}, account ${p.account ? `${p.account} (pinned)` : 'not pinned'}, region ${p.target.region ?? 'from the AWS profile'}`,
      `limits: ${describeLimits(p.limits)}`,
    );
    const allowed = d.suggestedScopes.filter((s) => p.limits.scopes.includes(s));
    const blocked = d.suggestedScopes.filter((s) => !p.limits.scopes.includes(s));
    if (d.hints.services.length) {
      lines.push(`scopes to request for this repo: ${allowed.join(', ')}`);
      if (blocked.length) lines.push(`useful but not allowed by the profile (only the user can widen it): ${blocked.join(', ')}`);
    }
    const enabled = p.limits.actions ?? [];
    lines.push(
      enabled.length
        ? `fix actions enabled (pf_aws_act, each one approved by the user): ${enabled.join(', ')}`
        : 'fix actions: none enabled for this profile. You can still diagnose; only the user can enable actions (pf profile add <name> --actions ...).',
    );
    lines.push('', 'Fix actions pf can run at all (a profile enables some of them):', ...ACTION_LINES.map((l) => `- ${l}`));
    lines.push('', 'Next: pf_aws_request_access with the fewest scopes and a clear reason.');
    return { ok: true, text: lines.join('\n') };
  },
};

const linkTool: Tool = {
  name: 'pf_aws_link_profile',
  description:
    'Use when no pf profile applies to this repo (pf_aws_profile or pf_aws_context says so). pf matches what the repo deploys to against the profiles pf supports and the AWS profiles on this machine, and the user picks one in a dialog. pf then links it to this repo. You never see credentials, and nothing changes unless the user approves.',
  inputSchema: objectSchema({ reason: { type: 'string', description: 'Why you need AWS access, shown to the user.' } }),
  readOnly: false,
  asksUser: true,
  async run(ctx, input, session) {
    if (!session) return fail('pf cannot ask the user outside an MCP session.');
    if (!session.elicit) {
      session.audit({ event: 'aws-link-decision', approved: false, error: 'no elicitation' });
      return fail('pf could not ask the user: this agent CLI does not show MCP elicitation dialogs. Ask the user to run `pf t --link` in a terminal.');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : '';
    const { hints, candidates } = linkChoices(ctx);
    const shown = candidates.slice(0, 8);
    if (shown.length === 0) {
      return fail('No AWS profiles are available: pf has none registered and ~/.aws/config lists none. Ask the user to run `aws configure sso`, then `pf t --link`.');
    }
    const byLabel = new Map(shown.map((c) => [candidateLabel(c), c]));
    const root = ctx.repo?.root ?? ctx.workdir;
    const message = [
      'The agent needs an AWS profile for this repo, and none is linked yet.',
      `Repo: ${root}`,
      `The repo mentions: accounts ${hints.accounts.join(', ') || 'none'}; regions ${hints.regions.join(', ') || 'none'}`,
      ...(reason ? [`Reason: ${reason}`] : []),
      '',
      'Profiles:',
      ...shown.map((c) => `- ${candidateLabel(c)}: ${candidateDetail(c)}`),
      '',
      `Linking writes "profile" to ${ctx.repo ? 'pf.json in this repo' : 'nothing (no repo): it applies to this session only'}. A new profile is registered in ~/.pf/config.json with the account pinned when known. Read access still needs its own approval.`,
    ].join('\n');
    session.audit({ event: 'aws-link-request', candidates: shown.map(candidateLabel), reason });
    let answer;
    try {
      answer = await session.elicit(message, {
        type: 'object',
        properties: {
          profile: { type: 'string', title: 'Profile for this repo', enum: [...byLabel.keys()], default: [...byLabel.keys()][0] },
          approve: { type: 'boolean', title: 'Link this profile to the repo', default: false },
        },
        required: ['profile', 'approve'],
      });
    } catch (e) {
      session.audit({ event: 'aws-link-decision', approved: false, error: e instanceof Error ? e.message : String(e) });
      return fail(`pf could not show the dialog: ${e instanceof Error ? e.message : String(e)}`);
    }
    const choice = typeof answer.content?.profile === 'string' ? byLabel.get(answer.content.profile) : undefined;
    const approved = answer.action === 'accept' && answer.content?.approve === true && Boolean(choice);
    session.audit({ event: 'aws-link-decision', approved, action: answer.action, ...(choice ? { choice: candidateLabel(choice) } : {}) });
    if (!approved || !choice) return fail('The user did not link a profile. Do not ask again unless they tell you to; continue without AWS or explain what you would need.');

    const linked = applyLink(ctx, choice);
    if (!linked.ok) return fail(`The user chose a profile, but pf could not link it: ${linked.reason}.`);
    // This server is one agent session: the linked profile applies to it even when pf.json could not be written.
    process.env.PF_PROFILE = linked.name;
    session.audit({ event: 'aws-link', profile: linked.name, registered: linked.registered, wroteRepo: linked.wroteRepo });
    return {
      ok: true,
      text: [
        `Linked pf profile "${linked.name}"${linked.registered ? ' (registered just now)' : ''}${linked.wroteRepo ? ' and saved it to this repo\'s pf.json' : ' for this session only (pf.json could not be written)'}.`,
        'Call pf_aws_profile to see its limits, then pf_aws_request_access.',
      ].join('\n'),
    };
  },
};

const actTool: Tool = {
  name: 'pf_aws_act',
  description:
    'Ask to run ONE AWS fix action (not a read): e.g. service "ecs", operation "update-service", params { "cluster": "web", "service": "api", "force-new-deployment": true }. Only actions the user enabled on the profile are accepted (pf_aws_context lists them), and every single call is shown to the user as the exact command; it runs only if they approve that call. Diagnose with pf_aws_describe first and say why the action fixes it.',
  inputSchema: objectSchema(
    {
      service: { type: 'string', description: 'AWS CLI service, e.g. ecs' },
      operation: { type: 'string', description: 'Operation, e.g. update-service' },
      params: { type: 'object', description: 'Flag -> value (string, number, true, or a list of strings). Only the flags pf accepts for that action.', additionalProperties: true },
      region: { type: 'string', description: 'Region. Defaults to the profile\'s.' },
      reason: { type: 'string', description: 'What you found and why this action fixes it. Shown to the user.' },
    },
    ['service', 'operation', 'reason'],
  ),
  readOnly: false,
  asksUser: true,
  async run(ctx, input, session) {
    const p = projectAws(ctx);
    if (!p.ok) return fail(p.problem);
    if (!session) return fail('pf cannot ask the user outside an MCP session.');
    const service = typeof input.service === 'string' ? input.service.trim() : '';
    const operation = typeof input.operation === 'string' ? input.operation.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!service || !operation) return fail('service and operation are required');
    if (!reason) return fail('reason is required: say what you found and why this action fixes it.');
    const checked = checkAction(service, operation, input.params, p.limits.actions ?? []);
    if (!checked.ok) {
      session.audit({ event: 'aws-action-refused', service, operation, reason: checked.reason });
      return fail(checked.reason);
    }
    if (!p.account) return fail(`Fix actions need a pinned account: the profile "${p.profile.name}" pins none. Only the user can set one, with pf profile add ${p.profile.name} --account <id>.`);
    // An approval is only ever the user's answer in a dialog: no client prompt stands in for it.
    if (!session.elicit) {
      session.audit({ event: 'aws-action-decision', service, operation, approved: false, error: 'no elicitation' });
      return fail('pf could not ask the user: fix actions need pf\'s own dialog, and this agent CLI does not show MCP elicitation dialogs. Tell the user what to run instead.');
    }
    const asked = typeof input.region === 'string' && input.region.trim() ? input.region.trim() : undefined;
    const region = asked ?? p.target.region ?? p.limits.regions?.[0];
    if (!region) return fail('No region: pass region, or set one on the profile.');
    if (p.limits.regions && !p.limits.regions.includes(region)) return fail(`Region ${region} is outside the profile's limits (${p.limits.regions.join(', ')}).`);

    const target: AwsTarget & { profile: string } = { profile: p.target.profile, region };
    const who = await whoami(target, p.account);
    if (!who.ok) {
      session.audit({ event: 'aws-account-mismatch', profile: p.profile.name, expected: p.account, ...(who.account ? { got: who.account } : {}) });
      return fail(who.text);
    }
    const argv = callArgv(service, operation, checked.argv, target);
    const command = formatCmd({ argv });
    session.audit({ event: 'aws-action-request', profile: p.profile.name, service, operation, region, command, reason });
    let answer;
    try {
      answer = await session.elicit(
        [
          'The agent asks pulpfixer to CHANGE something on AWS.',
          `Profile: ${p.profile.name} (from ${p.profile.source}), AWS profile ${p.target.profile}, account ${p.account} (verified)`,
          `Action: ${checked.action.summary}`,
          `Command: ${command}`,
          `Reason: ${reason}`,
          'This runs once, only if you approve it now. The agent never sees credentials.',
        ].join('\n'),
        {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Run this command', description: 'This one call only', default: false } },
          required: ['approve'],
        },
      );
    } catch (e) {
      session.audit({ event: 'aws-action-decision', service, operation, approved: false, error: e instanceof Error ? e.message : String(e) });
      return fail(`pf could not show the approval dialog: ${e instanceof Error ? e.message : String(e)}`);
    }
    const approved = answer.action === 'accept' && answer.content?.approve === true;
    session.audit({ event: 'aws-action-decision', service, operation, approved, action: answer.action });
    if (!approved) return fail('The user did not approve this action. Do not retry it unless they ask; explain what you would change instead.');

    const r = await awsRun(argv);
    session.audit({ event: 'aws-action', service, operation, region, ok: r.ok });
    if (!r.ok) return fail(`aws ${service} ${operation} failed${r.timedOut ? ' (timed out)' : ''}:\n${redactText(r.stderr).slice(0, 4000)}`);
    let text: string;
    try {
      text = r.stdout.trim() ? JSON.stringify(redactJson(JSON.parse(r.stdout)), null, 1) : '(no output)';
    } catch {
      text = r.stdout;
    }
    return { ok: true, text: `Done: ${service} ${operation} ran after the user approved it.\n${clip(redactText(text), r.truncated)}` };
  },
};

/** The fix actions the agent can ask for, one line each (shown by `pf_aws_profile` and the docs). */
export const ACTION_LINES = ACTIONS.map((a) => `${actionKey(a.service, a.operation)}: ${a.summary}`);

/** Tools the AWS plugin serves to agent CLIs. */
export const AWS_AGENT_TOOLS: Tool[] = [profileTool, requestTool, whoamiTool, describeTool, contextTool, linkTool, actTool];
