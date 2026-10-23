import fs from 'node:fs';
import type { Command } from '@pulpfixer/kit/types';
import { runCmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { ask } from '@pulpfixer/kit/ui/prompt';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { cpArgv, s3Uri } from '../aws.js';
import { loadExchange, saveExchange, uploadKey } from '../exchange.js';
import { needAws, needBucket } from './shared.js';

function showConfig(): void {
  const cfg = loadExchange();
  const c = out();
  const rows: [string, string][] = [
    ['bucket', cfg.bucket ?? c.dim('(not set)')],
    ['profile', cfg.profile],
    ['prefix', cfg.prefix || c.dim('(bucket root)')],
    ['region', cfg.region ?? c.dim('(from the profile)')],
  ];
  for (const [k, v] of rows) process.stdout.write(`  ${c.dim(k.padEnd(8))} ${v}\n`);
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Ask for each setting, starting from what is saved. Null when cancelled. */
async function wizard(): Promise<{ bucket: string; profile: string; prefix: string; region: string } | null> {
  const cur = loadExchange({});
  const bucket = await ask('Exchange bucket', {
    ...(cur.bucket ? { initial: cur.bucket } : {}),
    placeholder: 'my-exchange-bucket',
    validate: (v) => (BUCKET_RE.test(v) ? null : 'enter a valid S3 bucket name (3-63 chars: lowercase letters, digits, . and -)'),
  });
  if (bucket === null) return null;
  const profile = await ask('AWS profile', { initial: cur.profile, validate: (v) => (v ? null : 'a profile name is required') });
  if (profile === null) return null;
  const prefix = await ask('Folder in the bucket (optional)', { initial: cur.prefix, placeholder: 'bucket root' });
  if (prefix === null) return null;
  const region = await ask('Region (optional)', { initial: cur.region ?? '', placeholder: 'taken from the profile' });
  if (region === null) return null;
  return { bucket, profile, prefix, region };
}

async function setup(args: string[]): Promise<number> {
  const flags = {
    bucket: takeOption(args, '--bucket'),
    profile: takeOption(args, '--profile'),
    prefix: takeOption(args, '--prefix'),
    region: takeOption(args, '--region'),
  };
  let patch: { bucket?: string; profile?: string; prefix?: string; region?: string } = flags;
  // Flags save directly; a bare --setup in a terminal asks for each value.
  if (Object.values(flags).every((v) => v === undefined) && interactive()) {
    process.stderr.write(`${err().dim('Exchange bucket setup. Enter keeps the shown value, esc cancels.')}\n`);
    const answers = await wizard();
    if (!answers) {
      process.stderr.write(err().dim('cancelled, nothing saved\n'));
      return 130;
    }
    patch = answers;
  }
  if (Object.values(patch).some((v) => v !== undefined)) {
    if (!saveExchange(patch)) {
      process.stderr.write(`${badgeLabel('error', err())} could not write the pf config\n`);
      return 1;
    }
  }
  showConfig();
  if (patch.bucket && interactive()) process.stderr.write(`\n${err().dim('Try it:')} ${termLine('pf s3 <file>', err())}  ${err().dim('then')}  ${termLine('pf dl', err())}\n`);
  return 0;
}

export const s3Command: Command = {
  name: 's3',
  summary: 'Upload files to the exchange bucket',
  group: 'AWS',
  usage: 'pf s3 <file...> [--as <name>] [--dry-run] | pf s3 --setup [--bucket b] [--profile p] [--prefix x]',
  async run(_ctx, args) {
    const rest = [...args];
    if (takeFlag(rest, '--setup')) return await setup(rest);
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const as = takeOption(rest, '--as');
    const c = err();

    if (rest.length === 0) {
      process.stderr.write(`${badgeLabel('error', c)} give a file to upload: ${termLine('pf s3 <file>', c)}\n`);
      return 2;
    }
    if (as && rest.length > 1) {
      process.stderr.write(`${badgeLabel('error', c)} --as renames one file, but ${rest.length} were given\n`);
      return 2;
    }
    const bad = rest.filter((f) => !fs.existsSync(f) || !fs.statSync(f).isFile());
    if (bad.length) {
      process.stderr.write(`${badgeLabel('error', c)} not a file: ${bad.join(', ')}\n`);
      return 2;
    }
    const cfg = needBucket(loadExchange());
    if (!cfg) return 2;
    if (!dryRun && !needAws()) return 127;

    let failed = 0;
    for (const file of rest) {
      const key = uploadKey(cfg.prefix, file, as);
      const code = await runCmd({ argv: cpArgv(file, s3Uri(cfg.bucket, key), cfg) }, { dryRun });
      if (code !== 0) {
        failed++;
        continue;
      }
      if (!dryRun) process.stderr.write(`${c.green('✓')} ${key.slice(cfg.prefix.length)}  ${c.dim('download with')} ${termLine(`pf dl ${key.slice(cfg.prefix.length)}`, c)}\n`);
    }
    return failed ? 1 : 0;
  },
};
