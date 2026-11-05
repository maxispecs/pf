import path from 'node:path';
import { writeHomeFile } from '@pulpfixer/kit/config';
import { pfHome } from '@pulpfixer/kit/constants';
import { readJson } from '@pulpfixer/kit/util';

/**
 * AWS access the user approved for one agent session. Kept in `~/.pf/agent/grants.json` (no
 * credentials, only names and limits) so `pf aws grants` and `pf aws revoke` work from another
 * terminal. The MCP server re-reads it on every call, so a revoke takes effect at once. A grant
 * ends when it expires or when the server process that owns it is gone.
 */
export interface Grant {
  /** MCP server session id. */
  session: string;
  /** Process serving that session. */
  pid: number;
  /** pf profile name. */
  profile: string;
  awsProfile: string;
  account?: string;
  scopes: string[];
  /** Null means any region. */
  regions: string[] | null;
  grantedAt: string;
  expiresAt: string;
  reason: string;
  /** `dialog`: the user answered pf's elicitation. `agent-cli-prompt`: the agent CLI's own tool prompt. */
  approvedBy: 'dialog' | 'agent-cli-prompt';
  /** The credentials resolved to the pinned account (checked once per grant). */
  verified?: boolean;
}

const REL = path.join('agent', 'grants.json');

export function grantsPath(): string {
  return path.join(pfHome(), REL);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isGrant(g: unknown): g is Grant {
  const o = g as Partial<Grant> | null;
  return Boolean(o && typeof o.session === 'string' && typeof o.pid === 'number' && typeof o.profile === 'string' && Array.isArray(o.scopes) && typeof o.expiresAt === 'string');
}

function readAll(): Grant[] {
  const raw = readJson<{ grants?: unknown }>(grantsPath());
  return Array.isArray(raw?.grants) ? raw.grants.filter(isGrant) : [];
}

function writeAll(grants: Grant[]): boolean {
  return writeHomeFile(REL, JSON.stringify({ grants }, null, 2) + '\n');
}

/** Grants that are still live: not expired, and their server is still running. */
export function liveGrants(now = Date.now()): Grant[] {
  return readAll().filter((g) => Date.parse(g.expiresAt) > now && alive(g.pid));
}

export function activeGrant(session: string, profile: string, now = Date.now()): Grant | undefined {
  return liveGrants(now).find((g) => g.session === session && g.profile === profile);
}

/** Store a grant, replacing this session's grant for the same profile and dropping dead ones. */
export function saveGrant(grant: Grant, now = Date.now()): boolean {
  const others = liveGrants(now).filter((g) => !(g.session === grant.session && g.profile === grant.profile));
  return writeAll([...others, grant]);
}

export function markVerified(session: string, profile: string): void {
  const all = liveGrants();
  const g = all.find((x) => x.session === session && x.profile === profile);
  if (!g) return;
  g.verified = true;
  writeAll(all);
}

/** End the grants `match` selects. Returns how many ended, or null when the file could not be written. */
export function revokeGrants(match: (g: Grant) => boolean): number | null {
  const all = liveGrants();
  const keep = all.filter((g) => !match(g));
  if (keep.length === all.length) return 0;
  return writeAll(keep) ? all.length - keep.length : null;
}

export function minutesLeft(g: Grant, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(g.expiresAt) - now) / 60_000));
}
