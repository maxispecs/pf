import fs from 'node:fs';
import path from 'node:path';
import { inspectPath } from './registry.js';
import { pfSkillsDir } from './discover.js';

/**
 * Skills whose helper files pf runs and copies into repos (the /ver CLI, the /pnpm helper). They change
 * often, so `pf update` installs and updates them in pf's own folder (`~/.pf/skills`) from the registry.
 * The copies bundled in the pf package are the offline fallback.
 */
export const STACK_SKILLS: readonly string[] = ['ver', 'pnpm'];

/**
 * A file of a stack skill in pf's own folder, or null. The skill must be a registry install or a
 * symlinked checkout (a hand-made folder is not ours to run) and the file must exist.
 */
export function homeSkillFile(skill: string, rel: string, dir: string = pfSkillsDir()): string | null {
  const skillDir = path.join(dir, skill);
  const kind = inspectPath(skillDir).kind;
  if (kind !== 'registry' && kind !== 'link') return null;
  const file = path.join(skillDir, rel);
  return fs.existsSync(file) ? file : null;
}
