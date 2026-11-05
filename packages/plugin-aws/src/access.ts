import type { AgentAwsScope, ProfileConfig } from '@pulpfixer/kit/config';
import { narrowLimits, type Limits } from '@pulpfixer/kit/profiles';

/**
 * What the agent may read on AWS. A scope is a set of `service -> operations`; anything not listed
 * is refused, so a new operation is one line here. Operations that return secrets, file contents,
 * user data or credentials are never listed, and the ones an agent would try anyway are in DENIED
 * with the reason it gets back.
 */
export interface Scope {
  name: string;
  summary: string;
  ops: Record<string, string[]>;
}

export const SCOPES: Scope[] = [
  { name: 'identity', summary: 'who the credentials are (always part of a grant)', ops: { sts: ['get-caller-identity'] } },
  {
    name: 'ec2',
    summary: 'instances, networking, volumes, auto scaling',
    ops: {
      ec2: [
        'describe-instances', 'describe-instance-status', 'describe-security-groups', 'describe-security-group-rules',
        'describe-subnets', 'describe-vpcs', 'describe-volumes', 'describe-snapshots', 'describe-images',
        'describe-network-interfaces', 'describe-route-tables', 'describe-addresses', 'describe-availability-zones',
        'describe-regions', 'describe-nat-gateways', 'describe-internet-gateways', 'describe-tags', 'describe-launch-templates',
      ],
      autoscaling: ['describe-auto-scaling-groups', 'describe-scaling-activities', 'describe-auto-scaling-instances'],
    },
  },
  {
    name: 'ecs',
    summary: 'clusters, services, tasks, task definitions (environment values redacted)',
    ops: {
      ecs: [
        'list-clusters', 'describe-clusters', 'list-services', 'describe-services', 'list-tasks', 'describe-tasks',
        'list-container-instances', 'describe-container-instances', 'list-task-definitions', 'describe-task-definition',
      ],
    },
  },
  {
    name: 'rds',
    summary: 'database instances, clusters, events, maintenance',
    ops: {
      rds: [
        'describe-db-instances', 'describe-db-clusters', 'describe-db-snapshots', 'describe-events',
        'describe-pending-maintenance-actions', 'describe-db-subnet-groups', 'describe-db-log-files',
      ],
    },
  },
  {
    name: 'elb',
    summary: 'load balancers, listeners, target groups and target health',
    ops: {
      elbv2: [
        'describe-load-balancers', 'describe-listeners', 'describe-rules', 'describe-target-groups', 'describe-target-health',
        'describe-load-balancer-attributes', 'describe-target-group-attributes',
      ],
      elb: ['describe-load-balancers', 'describe-instance-health'],
    },
  },
  {
    name: 'cloudwatch',
    summary: 'alarms and metrics',
    ops: { cloudwatch: ['describe-alarms', 'describe-alarm-history', 'list-metrics', 'get-metric-statistics', 'get-metric-data'] },
  },
  {
    name: 'logs',
    summary: 'CloudWatch Logs groups, streams and events (log text can hold secrets: opt in per profile)',
    ops: { logs: ['describe-log-groups', 'describe-log-streams', 'describe-metric-filters', 'filter-log-events', 'get-log-events'] },
  },
  {
    name: 'ssm-metadata',
    summary: 'managed instances, patch state, parameter names (never values)',
    ops: { ssm: ['describe-instance-information', 'describe-instance-patch-states', 'describe-parameters', 'list-commands'] },
  },
  {
    name: 's3-metadata',
    summary: 'buckets and object listings (never object contents)',
    ops: {
      s3api: [
        'list-buckets', 'get-bucket-location', 'get-bucket-versioning', 'get-bucket-encryption', 'get-public-access-block',
        'get-bucket-policy-status', 'get-bucket-lifecycle-configuration', 'list-objects-v2', 'head-object',
      ],
    },
  },
];

export const SCOPE_NAMES = SCOPES.map((s) => s.name);

/** Granted unless a profile says otherwise. `logs` needs an explicit opt-in. */
export const DEFAULT_SCOPES = SCOPE_NAMES.filter((s) => s !== 'logs');
export const DEFAULT_MAX_TTL = 60;
export const HARD_MAX_TTL = 480;
export const DEFAULT_TTL = 30;

/** Operations refused with a reason, whatever was granted. */
export const DENIED: Record<string, string> = {
  'secretsmanager get-secret-value': 'returns secret values',
  'ssm get-parameter': 'can return SecureString values',
  'ssm get-parameters': 'can return SecureString values',
  'ssm get-parameters-by-path': 'can return SecureString values',
  'ssm get-command-invocation': 'returns command output, which can hold secrets',
  'ssm start-session': 'opens a shell on an instance',
  's3api get-object': 'returns file contents',
  's3 cp': 'copies file contents',
  's3 sync': 'copies file contents',
  'kms decrypt': 'decrypts data',
  'lambda get-function': 'returns a download link to the code',
  'ec2 get-password-data': 'returns an instance password',
  'ec2 describe-instance-attribute': 'can return user data, which often holds secrets',
  'ec2 describe-launch-template-versions': 'returns user data, which often holds secrets',
  'autoscaling describe-launch-configurations': 'returns user data, which often holds secrets',
  'ecr get-login-password': 'returns a registry credential',
  'sts get-session-token': 'mints credentials',
  'sts assume-role': 'mints credentials',
  'sts get-federation-token': 'mints credentials',
  'iam create-access-key': 'mints credentials',
  'rds download-db-log-file-portion': 'returns log text outside the logs scope',
};

export function scopeOf(name: string): Scope | undefined {
  return SCOPES.find((s) => s.name === name);
}

/** The scope that allows `service operation`, among `granted`. */
export function scopeFor(service: string, operation: string, granted: string[]): string | undefined {
  return SCOPES.find((s) => granted.includes(s.name) && s.ops[service]?.includes(operation))?.name;
}

export type OpCheck = { ok: true; scope: string } | { ok: false; reason: string };

export function checkOperation(service: string, operation: string, granted: string[]): OpCheck {
  const denied = DENIED[`${service} ${operation}`];
  if (denied) return { ok: false, reason: `aws ${service} ${operation} is never allowed: it ${denied}.` };
  const scope = scopeFor(service, operation, granted);
  if (scope) return { ok: true, scope };
  const other = SCOPES.find((s) => s.ops[service]?.includes(operation));
  if (other) return { ok: false, reason: `aws ${service} ${operation} needs the "${other.name}" scope, which this grant does not include. Request it with pf_aws_request_access.` };
  return { ok: false, reason: `aws ${service} ${operation} is not a read-only operation pf allows. Call pf_aws_profile for the list.` };
}

/** The profile's caps, with defaults, narrowed by the repo's pf.json. */
export function limitsFor(profile: ProfileConfig, repo: AgentAwsScope | undefined): Limits {
  const caps = profile.agent?.aws ?? {};
  const region = profile.aws?.region;
  const base: Limits = {
    scopes: (caps.scopes ?? DEFAULT_SCOPES).filter((s) => SCOPE_NAMES.includes(s)),
    regions: caps.regions ?? (region ? [region] : null),
    maxTtlMinutes: Math.min(caps.maxTtlMinutes ?? DEFAULT_MAX_TTL, HARD_MAX_TTL),
  };
  const narrowed = narrowLimits(base, repo);
  if (!narrowed.scopes.includes('identity') && base.scopes.includes('identity')) narrowed.scopes.unshift('identity');
  return narrowed;
}

/** Flags pf sets itself, or that load files, change endpoints or decrypt. */
const DENIED_FLAGS = new Set([
  'profile', 'region', 'output', 'endpoint-url', 'cli-input-json', 'cli-input-yaml', 'generate-cli-skeleton', 'debug',
  'ca-bundle', 'no-verify-ssl', 'no-sign-request', 'cli-binary-format', 'with-decryption', 'color', 'no-paginate', 'page-size',
]);
const FLAG = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_VALUE = 2000;

export type ParamValue = string | number | boolean | string[];

/** Turn `{ "instance-ids": ["i-1"], "max-results": 5 }` into argv, or say what is wrong. */
export function paramArgv(params: unknown): { ok: true; argv: string[] } | { ok: false; reason: string } {
  if (params === undefined || params === null) return { ok: true, argv: [] };
  if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, reason: 'params must be an object of flag -> value' };
  const argv: string[] = [];
  const value = (flag: string, v: unknown): string | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v !== 'string') return null;
    if (v.length > MAX_VALUE) return null;
    if (/^(file|fileb|https?):\/\//i.test(v.trim())) throw new Error(`--${flag}: values that load a file or URL are not allowed`);
    if (v.startsWith('--')) throw new Error(`--${flag}: a value may not start with --`);
    return v;
  };
  try {
    for (const [raw, v] of Object.entries(params as Record<string, unknown>)) {
      const flag = raw.replace(/^--/, '');
      if (!FLAG.test(flag)) return { ok: false, reason: `"${raw}" is not a flag name (lowercase words joined by -)` };
      if (DENIED_FLAGS.has(flag)) return { ok: false, reason: `--${flag} is set by pf or not allowed` };
      if (v === true) {
        argv.push(`--${flag}`);
        continue;
      }
      if (v === false) continue;
      const list = Array.isArray(v) ? v : [v];
      if (list.length === 0 || list.length > 100) return { ok: false, reason: `--${flag}: give 1 to 100 values` };
      const values = list.map((x) => value(flag, x));
      if (values.some((x) => x === null)) return { ok: false, reason: `--${flag}: values must be strings or numbers up to ${MAX_VALUE} characters` };
      argv.push(`--${flag}`, ...(values as string[]));
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, argv };
}

const SECRET_WORD = /(secret|password|passwd|token|credential|private.?key|api.?key|userdata)/i;
/** Pagination tokens are needed to read the next page and hold nothing secret. */
const PAGINATION = /^next.?token$/i;
const SECRET_KEY = { test: (k: string) => SECRET_WORD.test(k) && !PAGINATION.test(k) };
const REDACTED = '[redacted by pf]';

/** Hide secret-looking fields: secret-named keys, every container environment value, and name/value pairs with a secret name. */
export function redactJson(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) {
    const envList = /^environment(variables)?$/i.test(key);
    return v.map((x) => {
      if (envList && x && typeof x === 'object' && !Array.isArray(x)) {
        const o = x as Record<string, unknown>;
        return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, /^value$/i.test(k) ? REDACTED : redactJson(val, k)]));
      }
      return redactJson(x, key);
    });
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const name = typeof (o.name ?? o.Name ?? o.Key) === 'string' ? String(o.name ?? o.Name ?? o.Key) : '';
    return Object.fromEntries(
      Object.entries(o).map(([k, val]) => {
        if (typeof val === 'string' && (SECRET_KEY.test(k) || (/^value$/i.test(k) && SECRET_KEY.test(name)))) return [k, REDACTED];
        return [k, redactJson(val, k)];
      }),
    );
  }
  return v;
}

/** Hide secret-looking text: access keys, private keys, bearer tokens, JWTs and `password=...` pairs. */
export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, REDACTED)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `$1 ${REDACTED}`)
    .replace(/\b(aws_secret_access_key|aws_session_token|password|passwd|secret|token|api[_-]?key)(\\?"?\s*[=:]\s*\\?"?)[^\s"'\\,;&]+/gi, `$1$2${REDACTED}`);
}
