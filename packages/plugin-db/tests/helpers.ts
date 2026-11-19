import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearDbDrivers,
  makeSession,
  registerDbDrivers,
  setDbDriverInstaller,
  type CompiledQuery,
  type ConnectionParams,
  type DbDriver,
  type QueryResult,
} from '@pulpfixer/kit/db';
import { buildContext } from '@pulpfixer/kit/context';
import { setKeychain, type Keychain } from '../src/secrets.js';

/** A fresh PF_HOME for one test file, no drivers and no keychain. */
export function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-db-test-'));
  process.env.PF_HOME = dir;
  clearDbDrivers();
  setDbDriverInstaller(null);
  setKeychain(null);
  return dir;
}

export interface FakeDriver extends DbDriver {
  /** Every statement run on any session. */
  log: CompiledQuery[];
  /** The params of each connect call (secrets included). */
  connects: { form: string; params: ConnectionParams }[];
  /** What the next statements answer. Default: `SELECT 1` -> one row, anything else no rows. */
  respond: (q: CompiledQuery) => QueryResult;
}

/** A driver that runs nothing: it records statements and answers from `respond`. */
export function fakeDriver(id = 'fake', dialect: DbDriver['dialect'] = 'mysql'): FakeDriver {
  const d: FakeDriver = {
    id,
    label: 'Fake',
    dialect,
    log: [],
    connects: [],
    respond: (q) => (q.text === 'SELECT 1' ? { rows: [{ '1': 1 }] } : { rows: [] }),
    forms: [
      {
        id: 'params',
        label: 'Host and port',
        fields: [
          { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
          { key: 'port', label: 'Port', kind: 'number', default: 3306 },
          { key: 'password', label: 'Password', kind: 'secret' },
          { key: 'ssl', label: 'Use TLS', kind: 'boolean', default: false },
        ],
      },
      { id: 'dsn', label: 'DSN', fields: [{ key: 'dsn', label: 'Connection string', kind: 'secret', required: true }] },
    ],
    describe: (form, p) => (form === 'dsn' ? 'dsn' : `${String(p.host)}:${String(p.port ?? '')}`),
    async connect(form, params) {
      d.connects.push({ form, params: { ...params } });
      return makeSession(
        async (q) => {
          d.log.push(q);
          return d.respond(q);
        },
        async () => undefined,
      );
    },
  };
  return d;
}

export function installFake(id = 'fake', dialect: DbDriver['dialect'] = 'mysql'): FakeDriver {
  const d = fakeDriver(id, dialect);
  registerDbDrivers([d]);
  return d;
}

/** A keychain kept in memory. */
export function memoryKeychain(): Keychain & { items: Map<string, string>; next: string } {
  const items = new Map<string, string>();
  const k = {
    items,
    label: 'test keychain',
    available: () => true,
    // The real ones prompt on the terminal; the test says what was typed.
    next: 'typed-secret',
    store(account: string) {
      items.set(account, k.next);
      return true;
    },
    read: (account: string) => items.get(account) ?? null,
    remove: (account: string) => void items.delete(account),
  };
  return k;
}

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `fn` with stdout and stderr captured and no terminal, whatever runs the tests. */
export async function capture(fn: () => Promise<number>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  const tty = [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY];
  const set = (s: NodeJS.ReadStream | NodeJS.WriteStream, v: boolean | undefined) => Object.defineProperty(s, 'isTTY', { value: v, configurable: true, writable: true });
  set(process.stdin, false);
  set(process.stdout, false);
  set(process.stderr, false);
  process.stdout.write = ((s: string | Uint8Array) => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (err.push(String(s)), true)) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    set(process.stdin, tty[0]);
    set(process.stdout, tty[1]);
    set(process.stderr, tty[2]);
  }
}

export const ctx = () => buildContext(os.tmpdir());
