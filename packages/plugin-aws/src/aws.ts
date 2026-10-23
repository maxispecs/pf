import { spawnSync } from 'node:child_process';
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

export const hasAws = (): boolean => which('aws') !== null;

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
