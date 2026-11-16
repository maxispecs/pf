import { capture } from '@pulpfixer/kit/exec';
import { quote } from '@pulpfixer/kit/util';
import type { HostConfig, SecretRef } from './config.js';

const IMDS = 'http://169.254.169.254/latest';

export interface Identity {
  instanceId: string;
  region: string;
  accountId: string;
  instanceType?: string;
  /** Instance profile ARN, when the instance has a role. */
  profileArn?: string;
}

/** Instance identity over IMDSv2. Null when this is not an EC2 instance (or IMDS is off). */
export async function instanceIdentity(timeoutMs = 1500): Promise<Identity | null> {
  try {
    const token = await fetch(`${IMDS}/api/token`, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!token.ok) return null;
    const headers = { 'X-aws-ec2-metadata-token': await token.text() };
    const doc = await fetch(`${IMDS}/dynamic/instance-identity/document`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!doc.ok) return null;
    const d = (await doc.json()) as { instanceId?: string; region?: string; accountId?: string; instanceType?: string };
    if (!d.instanceId || !d.region || !d.accountId) return null;
    const iam = await fetch(`${IMDS}/meta-data/iam/info`, { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    const info = iam?.ok ? ((await iam.json().catch(() => ({}))) as { InstanceProfileArn?: string }) : {};
    return {
      instanceId: d.instanceId,
      region: d.region,
      accountId: d.accountId,
      ...(d.instanceType ? { instanceType: d.instanceType } : {}),
      ...(info.InstanceProfileArn ? { profileArn: info.InstanceProfileArn } : {}),
    };
  } catch {
    return null;
  }
}

/** Region for AWS calls: the config, then the instance, then AWS_REGION. */
export function regionFor(config: HostConfig, identity: Identity | null): string | undefined {
  return config.region ?? identity?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
}

/** argv that prints one secret value on stdout. */
export function secretArgv(ref: SecretRef, region?: string): string[] {
  const argv =
    ref.source === 'ssm'
      ? ['aws', 'ssm', 'get-parameter', '--name', ref.name, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text']
      : ['aws', 'secretsmanager', 'get-secret-value', '--secret-id', ref.name, '--query', 'SecretString', '--output', 'text'];
  return region ? [...argv, '--region', region] : argv;
}

/** The first line of an AWS CLI error, without the value of anything. */
function awsError(stderr: string): string {
  const line = stderr.trim().split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/^An error occurred /, '').slice(0, 200) || 'aws cli failed';
}

export interface SecretEnv {
  env: Record<string, string>;
  failed: { env: string; ref: SecretRef; error: string }[];
}

/**
 * Read secrets with the instance role into an env object for one child process.
 * Values are never printed, logged or written; only the env var names leave this function.
 */
export function readSecrets(config: HostConfig, names: string[], region?: string): SecretEnv {
  const out: SecretEnv = { env: {}, failed: [] };
  for (const env of names) {
    const ref = config.secrets[env];
    if (!ref) {
      out.failed.push({ env, ref: { source: 'ssm', name: '' }, error: `no "${env}" entry in secrets` });
      continue;
    }
    const r = capture(secretArgv(ref, region), { timeout: 20_000 });
    const value = r.stdout.replace(/\r?\n$/, '');
    if (r.ok && value && value !== 'None') out.env[env] = value;
    else out.failed.push({ env, ref, error: r.ok ? 'empty value' : awsError(r.stderr) });
  }
  return out;
}

/** Which instances an SSM command goes to. */
export type Targets = { instances: string[] } | { tag: { key: string; value: string } };

const INSTANCE_ID = /^(i|mi)-[0-9a-f]{8,17}$/;
const TAG = /^([\w.:/=+\-@ ]{1,128})=([\w.:/=+\-@ ]{0,256})$/;

/** `--instances i-1,i-2` or `--tag Key=Value`. A string is an error message. */
export function parseTargets(instances: string | undefined, tag: string | undefined): Targets | string {
  if (instances && tag) return 'pass --instances or --tag, not both';
  if (instances) {
    const ids = instances.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((id) => !INSTANCE_ID.test(id));
    if (!ids.length || bad.length) return `not an instance id: ${bad.join(', ') || instances}`;
    return { instances: ids };
  }
  if (tag) {
    const m = TAG.exec(tag);
    if (!m) return `--tag must be Key=Value, got "${tag}"`;
    return { tag: { key: m[1]!, value: m[2]! } };
  }
  return 'say which instances: --instances i-0abc,i-0def or --tag Role=web';
}

export interface SendInput {
  targets: Targets;
  /** Shell lines AWS-RunShellScript runs as root, in order. */
  commands: string[];
  comment: string;
  region?: string;
  timeoutSeconds?: number;
}

/** argv for `aws ssm send-command` with the stock AWS-RunShellScript document. */
export function sendCommandArgv(input: SendInput): string[] {
  const target =
    'instances' in input.targets
      ? ['--instance-ids', ...input.targets.instances]
      : ['--targets', `Key=tag:${input.targets.tag.key},Values=${input.targets.tag.value}`];
  const params = { commands: input.commands, executionTimeout: [String(input.timeoutSeconds ?? 3600)] };
  const argv = [
    'aws', 'ssm', 'send-command',
    '--document-name', 'AWS-RunShellScript',
    ...target,
    '--comment', input.comment.slice(0, 100),
    '--parameters', JSON.stringify(params),
    '--query', 'Command.CommandId',
    '--output', 'text',
  ];
  return input.region ? [...argv, '--region', input.region] : argv;
}

/** `pf host <args>` as one root shell line. SSM's PATH may miss the npm global bin, so add it. */
export function pfHostLine(args: string[]): string {
  return `PATH="$PATH:/usr/local/bin:/usr/bin" pf host ${args.map(quote).join(' ')}`;
}
