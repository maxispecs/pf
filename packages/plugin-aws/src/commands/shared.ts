import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { awsCapture, hasAws, listArgv } from '../aws.js';
import { parseListing, type ExchangeConfig, type ExchangeObject } from '../exchange.js';

/** The config with a bucket, or null after telling the user how to set one. */
export function needBucket(cfg: ExchangeConfig): (ExchangeConfig & { bucket: string }) | null {
  if (cfg.bucket) return cfg as ExchangeConfig & { bucket: string };
  const c = err();
  process.stderr.write(
    `${badgeLabel('error', c)} no exchange bucket set.\n` +
      `Run the setup wizard: ${termLine('pf s3 --setup', c)}  ${c.dim('(or pass --bucket <name> [--profile p] [--prefix x])')}\n` +
      `${c.dim('or export PF_EXCHANGE_BUCKET (and PF_EXCHANGE_PROFILE, PF_EXCHANGE_PREFIX, PF_EXCHANGE_REGION)')}\n`,
  );
  return null;
}

export function needAws(): boolean {
  if (hasAws()) return true;
  process.stderr.write(`${badgeLabel('error', err())} the aws CLI is not on PATH. Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html\n`);
  return false;
}

/** Files in the exchange bucket, newest first. Null after printing the aws error. */
export function listExchange(cfg: ExchangeConfig & { bucket: string }): ExchangeObject[] | null {
  const r = awsCapture(listArgv(cfg.bucket, cfg.prefix, cfg));
  if (!r.ok) {
    process.stderr.write(`${badgeLabel('error', err())} could not list s3://${cfg.bucket}/${cfg.prefix}\n${r.error}\n`);
    return null;
  }
  try {
    return parseListing(r.stdout, cfg.prefix);
  } catch {
    process.stderr.write(`${badgeLabel('error', err())} unexpected output from aws s3api list-objects-v2\n`);
    return null;
  }
}
