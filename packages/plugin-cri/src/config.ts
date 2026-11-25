import fs from 'node:fs';
import path from 'node:path';
import { repoConfigPath, setRepoConfigSection, type SectionWrite } from '@pulpfixer/kit/config';
import { pfHome } from '@pulpfixer/kit/constants';
import { findRepo } from '@pulpfixer/kit/detect/repo';
import { readJson } from '@pulpfixer/kit/util';
import { buildEntry, checkTarget } from '@pulpfixer/plugin-aws/api';
import { CriError } from './errors.js';

/**
 * Configuration of the CRI event system on this machine.
 *
 * Publishers (how an event leaves the stack, see the landscape spec) live in `~/.pf/cri/publishers.json`
 * (mode 0600). A publisher holds where events go (bus, region) and which AWS profile to use, never a key:
 * credentials come from the profile or from the environment the aws CLI reads.
 *
 * The stack identity (`domain`, `stack`) belongs to the repo: the `cri` section of `pulpfixer.json`.
 */

/** The transports pf can publish to. EventBridge is the only one so far. */
export const PUBLISHER_TYPES = ['eventbridge'] as const;
export type PublisherType = (typeof PUBLISHER_TYPES)[number];

export interface Publisher {
  type: PublisherType;
  /** The route prefix this publisher handles (`@payments/`, `audit/`). No prefix: the default publisher. */
  prefix?: string;
  /** Event bus name or ARN. */
  bus: string;
  region?: string;
  /** AWS profile. Without one the aws CLI uses its default chain (`AWS_*` variables, the default profile). */
  profile?: string;
  /** `Source` of the events. Defaults to the stack name. */
  source?: string;
}

export interface Identity {
  domain: string;
  stack: string;
}

interface FileShape {
  version: 1;
  publishers: Publisher[];
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PREFIX_RE = /^@?[A-Za-z0-9][A-Za-z0-9._/-]*\/$/;

export function publishersPath(): string {
  return path.join(pfHome(), 'cri', 'publishers.json');
}

/** What `--prefix` / list show for a publisher. */
export const publisherName = (p: Pick<Publisher, 'prefix'>): string => p.prefix ?? 'default';

/** Check a publisher and return it in canonical form. Throws a `CriError` that says what is wrong. */
export function validatePublisher(input: unknown, label = 'the publisher'): Publisher {
  const bad = (m: string): CriError => new CriError(`${label}: ${m}`);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw bad('not an object');
  const o = input as Record<string, unknown>;
  const type = o.type === undefined ? 'eventbridge' : o.type;
  if (!(PUBLISHER_TYPES as readonly unknown[]).includes(type)) throw bad(`unknown type "${String(type)}" (supported: ${PUBLISHER_TYPES.join(', ')})`);
  const str = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.trim() === '') throw bad(`"${k}" must be a non-empty string`);
    return v.trim();
  };
  const prefix = str('prefix');
  if (prefix !== undefined && !PREFIX_RE.test(prefix)) {
    throw bad(`the prefix "${prefix}" must end with "/" so it matches whole segments (e.g. "@payments/" or "audit/")`);
  }
  const bus = str('bus');
  if (bus === undefined) throw bad('a bus (name or ARN) is required');
  const region = str('region');
  const profile = str('profile');
  const source = str('source');
  try {
    checkTarget({ ...(profile ? { profile } : {}), ...(region ? { region } : {}) });
    buildEntry({ source: source ?? 'cri.check', detailType: 'check', detail: {}, bus });
  } catch (e) {
    throw bad(e instanceof Error ? e.message.replace(/^the event: /, '') : String(e));
  }
  return {
    type: 'eventbridge',
    ...(prefix ? { prefix } : {}),
    bus: bus,
    ...(region ? { region } : {}),
    ...(profile ? { profile } : {}),
    ...(source ? { source } : {}),
  };
}

/** Check the whole list: valid entries, one per prefix, at most one default. */
export function validatePublishers(list: unknown): Publisher[] {
  if (!Array.isArray(list)) throw new CriError('"publishers" must be a list');
  const out = list.map((p, i) => validatePublisher(p, `publisher ${i + 1}`));
  const seen = new Set<string>();
  for (const p of out) {
    const name = publisherName(p);
    if (seen.has(name)) throw new CriError(`two publishers for "${name}"`, name === 'default' ? 'only one publisher may have no prefix' : `remove one: pf cri publisher remove ${name}`);
    seen.add(name);
  }
  return out;
}

/** Every saved publisher. A missing file is none; an unreadable or malformed one is an error (never silently replaced). */
export function loadPublishers(): Publisher[] {
  const file = publishersPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CriError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CriError(`${file} is not valid JSON`, 'fix or delete the file');
  }
  try {
    return validatePublishers((parsed as Partial<FileShape> | null)?.publishers ?? []);
  } catch (e) {
    if (e instanceof CriError) throw new CriError(`${file}: ${e.message}`, e.hint);
    throw e;
  }
}

function save(publishers: Publisher[]): void {
  const file = publishersPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: FileShape = { version: 1, publishers };
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Add a publisher, or replace the one with the same prefix. Returns whether it replaced one. */
export function putPublisher(input: unknown): { publisher: Publisher; replaced: boolean } {
  const publisher = validatePublisher(input);
  const all = loadPublishers();
  const name = publisherName(publisher);
  const at = all.findIndex((p) => publisherName(p) === name);
  if (at >= 0) all[at] = publisher;
  else all.push(publisher);
  save(all);
  return { publisher, replaced: at >= 0 };
}

/** Remove the publisher for a prefix (`default` for the default one). Returns it, or undefined. */
export function removePublisher(name: string): Publisher | undefined {
  const all = loadPublishers();
  const at = all.findIndex((p) => publisherName(p) === name);
  if (at < 0) return undefined;
  const [gone] = all.splice(at, 1);
  save(all);
  return gone;
}

// ---- identity ----

export interface PartialIdentity {
  domain?: string;
  stack?: string;
}

function isIdentityValue(v: unknown): v is string {
  return typeof v === 'string' && NAME_RE.test(v);
}

/** The repo root for `cwd`, or null outside a repo. */
export function repoRootOf(cwd: string = process.cwd()): string | null {
  return findRepo(cwd)?.root ?? null;
}

/** `cri.domain` / `cri.stack` of the repo's `pulpfixer.json`; what is missing or malformed is left out. */
export function readIdentity(root: string | null): PartialIdentity {
  if (!root) return {};
  const raw = readJson<{ cri?: unknown }>(repoConfigPath(root));
  const cri = raw?.cri;
  if (cri === null || typeof cri !== 'object' || Array.isArray(cri)) return {};
  const o = cri as Record<string, unknown>;
  return { ...(isIdentityValue(o.domain) ? { domain: o.domain } : {}), ...(isIdentityValue(o.stack) ? { stack: o.stack } : {}) };
}

/** A complete identity, or a `CriError` that says what to set. */
export function requireIdentity(partial: PartialIdentity): Identity {
  const missing = (['domain', 'stack'] as const).filter((k) => !partial[k]);
  if (missing.length) {
    throw new CriError(`this repo has no CRI ${missing.join(' and ')}`, 'pf cri identity --domain <domain> --stack <stack>  (saved in pulpfixer.json)');
  }
  return { domain: partial.domain!, stack: partial.stack! };
}

/** Save `domain` / `stack` into the `cri` section of the repo's `pulpfixer.json`. */
export function writeIdentity(root: string, values: PartialIdentity, opts: { dryRun?: boolean } = {}): SectionWrite {
  for (const [k, v] of Object.entries(values)) {
    if (!isIdentityValue(v)) return { ok: false, error: `${k} "${String(v)}" must be letters, digits, ".", "_" or "-" (at most 64, starting with a letter or digit)` };
  }
  return setRepoConfigSection(root, 'cri', values as Record<string, unknown>, opts);
}
