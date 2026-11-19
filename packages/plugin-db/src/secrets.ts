import { spawnSync } from 'node:child_process';
import { listenKeys } from '@pulpfixer/kit/ui/keys';
import { err } from '@pulpfixer/kit/ui/palette';
import { which } from '@pulpfixer/kit/util';
import { DbError } from './errors.js';

/**
 * Where a connection's secret (password, DSN) comes from. The connection file holds only this reference,
 * never the value:
 *   keychain  the OS keychain (macOS `security`, Linux `secret-tool`), entered once by `pf db add`
 *   env       an environment variable, read each time
 *   prompt    asked each time (needs a terminal)
 */
export type SecretRef = { from: 'keychain' } | { from: 'env'; name: string } | { from: 'prompt' };

export const KEYCHAIN_SERVICE = 'pulpfixer-db';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `keychain`, `env:NAME` or `prompt` (the `--secret-from` flag) as a reference, or why it is not one. */
export function parseSecretRef(spec: string): SecretRef | string {
  const s = spec.trim();
  if (s === 'keychain' || s === 'prompt') return { from: s };
  const m = /^env:(.+)$/.exec(s);
  if (m) return ENV_NAME.test(m[1]!) ? { from: 'env', name: m[1]! } : `"${m[1]}" is not an environment variable name`;
  return `"${spec}" is not a secret source: use keychain, env:NAME or prompt`;
}

export function describeRef(ref: SecretRef): string {
  return ref.from === 'env' ? `env:${ref.name}` : ref.from;
}

/** Check a reference read from the connection file. */
export function isSecretRef(v: unknown): v is SecretRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as { from?: unknown; name?: unknown };
  return r.from === 'keychain' || r.from === 'prompt' || (r.from === 'env' && typeof r.name === 'string' && ENV_NAME.test(r.name));
}

/** An OS keychain. The password never goes through argv: `security` and `secret-tool` read it themselves. */
export interface Keychain {
  label: string;
  available(): boolean;
  /** Ask for the password on the terminal and save it under `account`. Returns whether it was saved. */
  store(account: string): boolean;
  read(account: string): string | null;
  remove(account: string): void;
}

const macKeychain: Keychain = {
  label: 'macOS Keychain',
  available: () => which('security') !== null,
  store(account) {
    // `-w` last with no value makes security prompt for the password (twice) on the terminal.
    const r = spawnSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], { stdio: 'inherit' });
    return r.status === 0;
  },
  read(account) {
    const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
  },
  remove(account) {
    spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { stdio: 'ignore' });
  },
};

const linuxKeychain: Keychain = {
  label: 'the Secret Service keyring',
  available: () => which('secret-tool') !== null,
  store(account) {
    // secret-tool prompts for the password on the terminal when stdin is one.
    const r = spawnSync('secret-tool', ['store', `--label=pulpfixer ${account}`, 'service', KEYCHAIN_SERVICE, 'account', account], { stdio: 'inherit' });
    return r.status === 0;
  },
  read(account) {
    const r = spawnSync('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null;
  },
  remove(account) {
    spawnSync('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account], { stdio: 'ignore' });
  },
};

let override: Keychain | null | undefined;

/** Replace the keychain (tests). `null` means none is available; `undefined` restores the real one. */
export function setKeychain(k: Keychain | null | undefined): void {
  override = k;
}

/** The keychain of this machine, or null (Windows, or the tool is missing). */
export function keychain(): Keychain | null {
  if (override !== undefined) return override;
  const k = process.platform === 'darwin' ? macKeychain : process.platform === 'linux' ? linuxKeychain : null;
  return k && k.available() ? k : null;
}

/** The keychain account for one secret of one connection. */
export const keychainAccount = (connection: string, key: string): string => `${connection}.${key}`;

/** Read a line from the terminal without echoing it. Resolves null when cancelled or there is no terminal. */
export function askSecret(question: string): Promise<string | null> {
  const stream = process.stderr;
  if (!process.stdin.isTTY || !stream.isTTY) return Promise.resolve(null);
  const c = err();
  return new Promise((resolve) => {
    let value = '';
    stream.write(`${c.boldBrand('?')} ${c.bold(question)} ${c.dim('(hidden)')} `);
    const stop = listenKeys((str, key) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        stop();
        stream.write('\n');
        return resolve(null);
      }
      if (key.name === 'return' || key.name === 'enter') {
        stop();
        stream.write('\n');
        return resolve(value);
      }
      if (key.name === 'backspace') value = value.slice(0, -1);
      else if (key.ctrl && key.name === 'u') value = '';
      else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) value += str;
    });
  });
}

/** The secret a reference points to. Throws a `DbError` that says how to fix it. */
export async function resolveSecret(connection: string, key: string, ref: SecretRef): Promise<string> {
  if (ref.from === 'env') {
    const v = process.env[ref.name];
    if (!v) throw new DbError(`connection "${connection}" needs ${key} from $${ref.name}, which is not set`, `export ${ref.name}=...`);
    return v;
  }
  if (ref.from === 'keychain') {
    const k = keychain();
    if (!k) throw new DbError(`connection "${connection}" keeps ${key} in the keychain, which is not available here`, `pf db add ${connection} --secret-from env:NAME`);
    const v = k.read(keychainAccount(connection, key));
    if (v === null) throw new DbError(`connection "${connection}" has no ${key} in ${k.label}`, `pf db add ${connection}   (it asks for the ${key} again)`);
    return v;
  }
  const v = await askSecret(`${key} for ${connection}:`);
  if (v === null) throw new DbError(`connection "${connection}" asks for ${key}, and there is no terminal to ask on`, `pf db add ${connection} --secret-from env:NAME`);
  return v;
}
