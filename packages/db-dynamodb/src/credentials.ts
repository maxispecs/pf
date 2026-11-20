import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * AWS credentials for one connection, with no SDK:
 *
 *   1. keys given to the connection (the `keys` form),
 *   2. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (/ `AWS_SESSION_TOKEN`), when no profile is named,
 *   3. static keys of the profile in the shared credentials file (`~/.aws/credentials`),
 *   4. whatever the `aws` CLI resolves for the profile (`aws configure export-credentials`): SSO,
 *      assume-role, `credential_process`. This runs the CLI the AWS plugin already needs; nothing is
 *      installed and its output is read, not stored.
 *
 * Credentials are held in memory only, and refreshed shortly before they expire. Never log them.
 */

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When they stop working (a temporary credential). */
  expiration?: Date;
}

export class CredentialsError extends Error {}

export interface CredentialSource {
  /** The `keys` form: values given to the connection. */
  keys?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** The AWS profile name, when one was chosen. */
  profile?: string;
  env?: NodeJS.ProcessEnv;
  /** The shared credentials file to read. Default `AWS_SHARED_CREDENTIALS_FILE`, else `~/.aws/credentials`. */
  credentialsFile?: string;
  /** Runs the `aws` CLI (tests replace it). Resolves with its stdout. */
  runAws?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

/** A profile name is passed to the aws CLI as an argument, so it may not look like an option. */
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.@:+=,-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9]{8,128}$/;

export function checkProfileName(profile: string): string {
  if (!PROFILE.test(profile)) throw new CredentialsError(`"${profile}" is not a valid AWS profile name`);
  return profile;
}

/** The sections of an ini file (`[name]`, `key = value`; `#` and `;` start comments). */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = out[head[1]!.trim()] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (section && eq > 0) section[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

function fromEnv(env: NodeJS.ProcessEnv): Credentials | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
}

function fromFile(profile: string, file: string): Credentials | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const section = parseIni(text)[profile];
  const accessKeyId = section?.aws_access_key_id;
  const secretAccessKey = section?.aws_secret_access_key;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, ...(section?.aws_session_token ? { sessionToken: section.aws_session_token } : {}) };
}

/** The `process` format of `aws configure export-credentials`. */
export function parseExported(stdout: string): Credentials {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new CredentialsError('the aws CLI did not return credentials as JSON');
  }
  if (typeof j.AccessKeyId !== 'string' || typeof j.SecretAccessKey !== 'string') throw new CredentialsError('the aws CLI returned no access key');
  const expiration = typeof j.Expiration === 'string' ? new Date(j.Expiration) : undefined;
  return {
    accessKeyId: j.AccessKeyId,
    secretAccessKey: j.SecretAccessKey,
    ...(typeof j.SessionToken === 'string' && j.SessionToken ? { sessionToken: j.SessionToken } : {}),
    ...(expiration && !Number.isNaN(expiration.getTime()) ? { expiration } : {}),
  };
}

const defaultRunAws = (args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('aws', args, { env, timeout: 60_000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new CredentialsError('the aws CLI is not installed (needed for SSO and assume-role profiles)'));
      const why = String(stderr).split('\n').find((l) => l.trim()) ?? err.message;
      reject(new CredentialsError(`the aws CLI could not provide credentials: ${why.trim()}`));
    });
  });

/** Resolve credentials once. */
export async function resolveCredentials(src: CredentialSource): Promise<Credentials> {
  if (src.keys) {
    if (!KEY_ID.test(src.keys.accessKeyId)) throw new CredentialsError('the access key id does not look like one');
    return { ...src.keys };
  }
  const env = src.env ?? process.env;
  if (!src.profile) {
    const e = fromEnv(env);
    if (e) return e;
  }
  const profile = checkProfileName(src.profile ?? env.AWS_PROFILE ?? 'default');
  const file = src.credentialsFile ?? env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), '.aws', 'credentials');
  const f = fromFile(profile, file);
  if (f) return f;

  const explicit = src.profile ?? env.AWS_PROFILE;
  const args = ['configure', 'export-credentials', '--format', 'process', ...(explicit ? ['--profile', checkProfileName(explicit)] : [])];
  try {
    return parseExported(await (src.runAws ?? defaultRunAws)(args, env));
  } catch (e) {
    if (e instanceof CredentialsError && !explicit && /not installed/.test(e.message)) {
      throw new CredentialsError('no AWS credentials found: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, name a profile, or install the aws CLI');
    }
    throw e;
  }
}

/** Credentials that are resolved on first use and again a minute before they expire. */
export function cachedCredentials(src: CredentialSource, now: () => number = Date.now): { get(): Promise<Credentials>; invalidate(): void } {
  let current: Promise<Credentials> | undefined;
  let expiresAt = Infinity;
  return {
    get() {
      if (!current || now() >= expiresAt - 60_000) {
        const p = resolveCredentials(src);
        current = p;
        p.then(
          (c) => {
            if (current === p) expiresAt = c.expiration ? c.expiration.getTime() : Infinity;
          },
          () => {
            if (current === p) current = undefined;
          },
        );
      }
      return current;
    },
    invalidate() {
      current = undefined;
    },
  };
}
