import { objectSchema, type Tool, type ToolResult, type ToolSession } from '@pulpfixer/kit/agent-tool';
import type { Context } from '@pulpfixer/kit/context';
import { checkOperation, DEFAULT_TTL, paramArgv, redactJson, redactText, SCOPE_NAMES, scopeOf } from './access.js';
import { awsRun, callArgv, whoamiArgv, type AwsTarget } from './aws.js';
import { activeGrant, markVerified, minutesLeft, saveGrant, type Grant } from './grants.js';
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

/** Tools the AWS plugin serves to agent CLIs. */
export const AWS_AGENT_TOOLS: Tool[] = [profileTool, requestTool, whoamiTool, describeTool];
