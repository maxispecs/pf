import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UserConfig } from '@pulpfixer/kit/config';
import { exists } from '@pulpfixer/kit/util';
import { pfHome } from '@pulpfixer/kit/constants';
import { packageRoot } from '@pulpfixer/kit/version';

export interface Skill {
  name: string;
  description: string;
  /** Directory holding SKILL.md. */
  dir: string;
  /** Where it was found, e.g. "~/.cursor/skills". */
  source: string;
  version?: string;
}

/** Parse the frontmatter of a SKILL.md. Handles plain, quoted and folded (`>`, `|`) scalars. */
export function parseSkillFile(text: string, fallbackName: string): Omit<Skill, 'dir' | 'source'> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = m?.[1] ?? '';
  const lines = fm.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!km) continue;
    let value = km[2]!.trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    }
    fields[km[1]!] = value.replace(/^["']|["']$/g, '');
  }
  const version = /^\s+version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(fm)?.[1];
  return {
    name: fields.name || fallbackName,
    description: fields.description ?? '',
    ...(version ? { version } : {}),
  };
}

function scan(dir: string, source: string, depth: number, out: Skill[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink()) || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    const file = path.join(sub, 'SKILL.md');
    if (exists(file)) {
      try {
        out.push({ ...parseSkillFile(fs.readFileSync(file, 'utf8'), e.name), dir: sub, source });
      } catch {
        // unreadable skill: skip
      }
    } else if (depth > 0) {
      scan(sub, source, depth - 1, out);
    }
  }
}

/** Source label of the skills that ship with pf. */
export const BUNDLED_LABEL = 'pulpfixer';

export function bundledSkillsDir(): string {
  return path.join(packageRoot(), 'assets', 'skills');
}

/** Source label of pf's own skills folder, where `pf skill install` puts registry skills. */
export const PF_SKILLS_LABEL = '~/.pf/skills';

export function pfSkillsDir(): string {
  return path.join(pfHome(), 'skills');
}

/** Skills pf runs itself (through pf agent and pf_skill) rather than handing to an agent CLI by name. */
export function isPfSkill(skill: Skill): boolean {
  return skill.source === BUNDLED_LABEL || skill.source === PF_SKILLS_LABEL;
}

/**
 * Directories scanned for skills, in priority order. pf's folder and its bundled skills come last
 * so a repo or agent copy wins; a registry install in pf's folder wins over the bundled copy.
 */
export function skillDirs(
  repoRoot: string | null,
  user: UserConfig,
  home = os.homedir(),
  bundled: string | null = bundledSkillsDir(),
  own: string | null = pfSkillsDir(),
): { dir: string; label: string }[] {
  const dirs: { dir: string; label: string }[] = [];
  if (repoRoot) {
    for (const d of ['.cursor/skills', '.agents/skills', '.claude/skills']) dirs.push({ dir: path.join(repoRoot, d), label: d });
  }
  for (const d of ['.cursor/skills', '.cursor/skills-cursor', '.agents/skills', '.claude/skills']) {
    dirs.push({ dir: path.join(home, d), label: `~/${d}` });
  }
  for (const d of user.skillDirs ?? []) dirs.push({ dir: d.replace(/^~(?=\/)/, home), label: d });
  if (own) dirs.push({ dir: own, label: PF_SKILLS_LABEL });
  if (bundled) dirs.push({ dir: bundled, label: BUNDLED_LABEL });
  return dirs;
}

/** Discover skills, one per name; earlier directories win. Sorted by name. */
export function discoverSkills(repoRoot: string | null, user: UserConfig, home?: string, bundled?: string | null, own?: string | null): Skill[] {
  const all: Skill[] = [];
  for (const { dir, label } of skillDirs(repoRoot, user, home, bundled, own)) scan(dir, label, 3, all);
  const byName = new Map<string, Skill>();
  for (const s of all) if (!byName.has(s.name)) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** First sentence of a description, trimmed to a menu-friendly length. */
export function shortDescription(text: string, max = 70): string {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}
