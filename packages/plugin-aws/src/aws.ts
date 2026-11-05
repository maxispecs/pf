import { spawn, spawnSync } from 'node:child_process';
import { which } from '@pulpfixer/kit/util';

/** Which AWS account and region to talk to. */
export interface AwsTarget {
  profile?: string;
  region?: string;
}

export const s3Uri = (bucket: string, key: string): string => `s3://${bucket}/${key}`;

/** `--profile` and `--region` for a target. */
export function awsGlobalArgs(t: AwsTarget): string[] {
  return [...(t.profile ? ['--profile', t.profile] : []), ...(t.region ? ['--region', t.region] : [])];
}

/** `aws s3 cp <from> <to>` (either side may be an s3:// URI). */
export function cpArgv(from: string, to: string, t: AwsTarget): string[] {
  return ['aws', 's3', 'cp', from, to, ...awsGlobalArgs(t)];
}

/** Every key's [Key, LastModified, Size], kept small so big buckets stay under the output limit. */
export function listArgv(bucket: string, prefix: string, t: AwsTarget): string[] {
  return [
    'aws', 's3api', 'list-objects-v2',
    '--bucket', bucket,
    ...(prefix ? ['--prefix', prefix] : []),
    '--query', 'Contents[].[Key,LastModified,Size]',
    '--output', 'json',
    ...awsGlobalArgs(t),
  ];
}

/** `aws sts get-caller-identity` as JSON. */
export function whoamiArgv(t: AwsTarget): string[] {
  return ['aws', 'sts', 'get-caller-identity', '--output', 'json', ...awsGlobalArgs(t)];
}

/** One read call: `aws <service> <operation> <params> --output json --profile p --region r`. */
export function callArgv(service: string, operation: string, params: string[], t: AwsTarget): string[] {
  return ['aws', service, operation, ...params, '--output', 'json', ...awsGlobalArgs(t)];
}

export const hasAws = (): boolean => which('aws') !== null;

export interface AwsJsonResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** stdout went past the limit and was cut. */
  truncated: boolean;
  timedOut: boolean;
}

/** Run an aws command without blocking (the MCP server keeps answering), stdout and stderr apart. Never prompts. */
export function awsRun(argv: string[], opts: { timeout?: number; maxBytes?: number } = {}): Promise<AwsJsonResult> {
  const max = opts.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' } });
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < max) stdout += c.toString('utf8');
      else truncated = true;
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 20_000) stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeout ?? 60_000);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: e.code === 'ENOENT' ? 'aws CLI not found on PATH' : e.message, truncated, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr: stderr.trim(), truncated, timedOut });
    });
  });
}

export type AwsResult = { ok: true; stdout: string } | { ok: false; error: string };

/** Run an aws command and capture its output. Never prompts. */
export function awsCapture(argv: string[]): AwsResult {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AWS_PAGER: '' },
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? 'aws CLI not found on PATH' : r.error.message };
  }
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `aws exited with ${r.status}` };
  return { ok: true, stdout: r.stdout ?? '' };
}
