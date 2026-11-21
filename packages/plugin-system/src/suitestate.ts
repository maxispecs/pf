import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from '@pulpfixer/kit/constants';
import { readJson } from '@pulpfixer/kit/util';

/**
 * What `pf suite enable` applied on this machine: `~/.pf/sys/suite-state.json`. Cursor needs no entry (its
 * state is what Cursor has installed); an optional feature is "on" once it was applied, with the places it
 * went (Obsidian vaults). Read-only for the rest of pf, and a corrupt file reads as empty.
 */
export interface FeatureState {
  /** Places the feature was applied to (vault paths). */
  targets: string[];
  /** Version of the preset applied last. */
  version: string;
  at: string;
}

export interface SuiteState {
  features: Record<string, FeatureState>;
}

export const suiteStatePath = (): string => path.join(pfHome(), 'sys', 'suite-state.json');

export function readSuiteState(): SuiteState {
  const raw = readJson<{ features?: unknown }>(suiteStatePath());
  const features: Record<string, FeatureState> = {};
  if (raw && raw.features && typeof raw.features === 'object' && !Array.isArray(raw.features)) {
    for (const [id, v] of Object.entries(raw.features as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const x = v as Record<string, unknown>;
      features[id] = {
        targets: Array.isArray(x.targets) ? x.targets.filter((t): t is string => typeof t === 'string') : [],
        version: typeof x.version === 'string' ? x.version : '',
        at: typeof x.at === 'string' ? x.at : '',
      };
    }
  }
  return { features };
}

/** Remember that a feature was applied (to `target`, when it has places). Returns an error message, or null. */
export function recordEnabled(id: string, target: string | null, version: string, now: Date = new Date()): string | null {
  const state = readSuiteState();
  const prev = state.features[id];
  const targets = [...(prev?.targets ?? [])];
  if (target && !targets.includes(target)) targets.push(target);
  state.features[id] = { targets, version, at: now.toISOString() };
  const file = suiteStatePath();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return null;
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean
    }
    return `could not save ${file}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
