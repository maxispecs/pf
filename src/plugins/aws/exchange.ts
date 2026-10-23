import path from 'node:path';
import { pluginSettings, savePluginSettings } from '../settings.js';
import type { AwsTarget } from './aws.js';

/** The shared exchange bucket: where `pf s3` uploads and `pf dl` downloads. */
export interface ExchangeConfig extends AwsTarget {
  bucket?: string;
  profile: string;
  /** Key prefix with a trailing slash, or empty for the bucket root. */
  prefix: string;
}

export const DEFAULT_PROFILE = 'exchange';
const SETTINGS = 'aws';

export function normalizePrefix(p: string | undefined): string {
  const t = (p ?? '').trim().replace(/^\/+/, '');
  return t && !t.endsWith('/') ? `${t}/` : t;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Saved settings (`plugins.aws.exchange` in ~/.pf/config.json), overridden by `PF_EXCHANGE_*` env vars. */
export function loadExchange(env: NodeJS.ProcessEnv = process.env): ExchangeConfig {
  const saved = pluginSettings(SETTINGS).exchange;
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const bucket = str(env.PF_EXCHANGE_BUCKET) ?? str(s.bucket);
  const region = str(env.PF_EXCHANGE_REGION) ?? str(s.region);
  return {
    ...(bucket ? { bucket } : {}),
    ...(region ? { region } : {}),
    profile: str(env.PF_EXCHANGE_PROFILE) ?? str(s.profile) ?? DEFAULT_PROFILE,
    prefix: normalizePrefix(str(env.PF_EXCHANGE_PREFIX) ?? str(s.prefix)),
  };
}

/** Save the given fields (others are kept). Returns false when ~/.pf is not writable. */
export function saveExchange(patch: { bucket?: string; profile?: string; prefix?: string; region?: string }): boolean {
  const current = (pluginSettings(SETTINGS).exchange ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = k === 'prefix' ? normalizePrefix(v) : v.trim();
  return savePluginSettings(SETTINGS, { exchange: next });
}

export interface ExchangeObject {
  key: string;
  /** Key without the exchange prefix. */
  name: string;
  modified: Date;
  size: number;
}

/** Parse `listArgv` output, drop folder markers, and sort newest first. */
export function parseListing(stdout: string, prefix: string): ExchangeObject[] {
  const text = stdout.trim();
  if (!text || text === 'null') return [];
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows)) return [];
  const objects: ExchangeObject[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const [key, modified, size] = r as [unknown, unknown, unknown];
    if (typeof key !== 'string' || key.endsWith('/')) continue;
    const when = new Date(String(modified));
    objects.push({
      key,
      name: prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key,
      modified: Number.isNaN(when.getTime()) ? new Date(0) : when,
      size: Number(size) || 0,
    });
  }
  return objects.sort((a, b) => b.modified.getTime() - a.modified.getTime() || a.name.localeCompare(b.name));
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Local time, `YYYY-MM-DD HH:mm`. */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The key a local file uploads to: prefix + (explicit name or the file's own name). */
export function uploadKey(prefix: string, file: string, as?: string): string {
  return prefix + (as?.replace(/^\/+/, '') || path.basename(file));
}

export type Match = { kind: 'one'; object: ExchangeObject } | { kind: 'many'; objects: ExchangeObject[] } | { kind: 'none' };

/** Find a file by name: exact, then exact ignoring case, then a unique substring. */
export function findObject(objects: ExchangeObject[], query: string): Match {
  const q = query.replace(/^\/+/, '');
  const exact = objects.filter((o) => o.name === q || o.key === q);
  if (exact.length) return { kind: 'one', object: exact[0]! };
  const lower = q.toLowerCase();
  const caseless = objects.filter((o) => o.name.toLowerCase() === lower);
  if (caseless.length === 1) return { kind: 'one', object: caseless[0]! };
  const part = objects.filter((o) => o.name.toLowerCase().includes(lower));
  if (part.length === 1) return { kind: 'one', object: part[0]! };
  return part.length ? { kind: 'many', objects: part } : { kind: 'none' };
}
