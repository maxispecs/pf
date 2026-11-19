import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from '@pulpfixer/kit/constants';
import type { ConnectionForm } from '@pulpfixer/kit/db';
import { DbError } from './errors.js';
import { isSecretRef, type SecretRef } from './secrets.js';

/**
 * Saved connections: `~/.pf/db/connections.json` (mode 0600). A connection holds its driver, the form it
 * was made with, the plain values (host, port, file...) and, for each secret field, only a reference to
 * where the secret lives (`SecretRef`). The file never holds a password.
 */
export interface Connection {
  driver: string;
  form: string;
  params: Record<string, string | number | boolean>;
  secrets: Record<string, SecretRef>;
}

interface FileShape {
  version: 1;
  connections: Record<string, Connection>;
}

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function connectionsPath(): string {
  return path.join(pfHome(), 'db', 'connections.json');
}

export function checkName(name: string): string | null {
  return NAME_RE.test(name) ? null : 'use lowercase letters, digits, - and _ (at most 40, starting with a letter or digit)';
}

function parseConnection(name: string, v: unknown): Connection {
  const o = v as Partial<Connection> | null;
  if (!o || typeof o !== 'object' || typeof o.driver !== 'string' || typeof o.form !== 'string') {
    throw new DbError(`connection "${name}" in ${connectionsPath()} is malformed`, `pf db remove ${name}`);
  }
  const params: Connection['params'] = {};
  for (const [k, val] of Object.entries(o.params && typeof o.params === 'object' ? o.params : {})) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') params[k] = val;
  }
  const secrets: Connection['secrets'] = {};
  for (const [k, val] of Object.entries(o.secrets && typeof o.secrets === 'object' ? o.secrets : {})) {
    if (isSecretRef(val)) secrets[k] = val;
  }
  return { driver: o.driver, form: o.form, params, secrets };
}

/** Every saved connection. A missing file is none; an unreadable one is an error (never silently replaced). */
export function loadConnections(): Record<string, Connection> {
  const file = connectionsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new DbError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DbError(`${file} is not valid JSON`, 'fix or delete the file');
  }
  const conns = (parsed as Partial<FileShape> | null)?.connections;
  const out: Record<string, Connection> = {};
  if (conns && typeof conns === 'object') for (const [name, v] of Object.entries(conns)) out[name] = parseConnection(name, v);
  return out;
}

function save(connections: Record<string, Connection>): void {
  const file = connectionsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: FileShape = { version: 1, connections };
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function getConnection(name: string): Connection | undefined {
  return loadConnections()[name];
}

export function putConnection(name: string, conn: Connection): void {
  const problem = checkName(name);
  if (problem) throw new DbError(`"${name}" is not a connection name: ${problem}`);
  const all = loadConnections();
  all[name] = conn;
  save(all);
}

/** Remove a connection. Returns the removed one (to clean up its keychain entries) or undefined. */
export function removeConnection(name: string): Connection | undefined {
  const all = loadConnections();
  const gone = all[name];
  if (!gone) return undefined;
  delete all[name];
  save(all);
  return gone;
}

/**
 * Split what the user entered into plain values and the secret fields of the form.
 * Values for secret fields are dropped here: they only ever travel as references.
 */
export function plainParams(form: ConnectionForm, values: Record<string, string | number | boolean>): Connection['params'] {
  const secret = new Set(form.fields.filter((f) => f.kind === 'secret').map((f) => f.key));
  return Object.fromEntries(Object.entries(values).filter(([k]) => !secret.has(k)));
}
