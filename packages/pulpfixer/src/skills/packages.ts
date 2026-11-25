import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readJson } from '@pulpfixer/kit/util';

/**
 * Skills that ship inside pf as packages (data only, pinned dependencies of core, like kit):
 *   @pulpfixer/skill-version   version
 *   @pulpfixer/skill-repo      pf-repo, deploy-setup, pnpm
 * Each package holds `skills/<name>/SKILL.md` (and the skill's scripts). pf reads them from node_modules, so
 * there is no bundled copy to keep in step and no registry fetch: updating pf updates them.
 */
export const SKILL_PACKAGES: readonly string[] = ['@pulpfixer/skill-version', '@pulpfixer/skill-repo'];

/** Names that used to be skills of the external skills repo (`@pf-skills/ver`) and still work. */
export const SKILL_ALIASES: Readonly<Record<string, string>> = { ver: 'version' };

/** The legacy registry installs (`@pf-skills/<name>`) that these packages replace. */
export const RETIRED_SKILL_PACKAGES: readonly string[] = ['@pf-skills/ver', '@pf-skills/pnpm', '@pf-skills-ver/ver', '@pf-skills-pnpm/pnpm'];

export interface PackagedSkill {
  name: string;
  /** Folder holding SKILL.md. */
  dir: string;
  /** `@pulpfixer/skill-repo`. */
  package: string;
  version: string;
}

/** Root folder of an installed skill package, or null when it cannot be found. */
export function skillPackageRoot(pkg: string): string | null {
  try {
    return path.dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
}

/** Every skill that ships with this pf, sorted by name. */
export function packagedSkills(): PackagedSkill[] {
  const found: PackagedSkill[] = [];
  for (const pkg of SKILL_PACKAGES) {
    const root = skillPackageRoot(pkg);
    if (!root) continue;
    const version = readJson<{ version?: string }>(root, 'package.json')?.version ?? '0.0.0';
    const base = path.join(root, 'skills');
    let names: string[];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(base, name);
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) found.push({ name, dir, package: pkg, version });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The `skills/` folder of each skill package: pf's skill discovery scans them. */
export function packagedSkillsDirs(): string[] {
  return SKILL_PACKAGES.flatMap((pkg) => {
    const root = skillPackageRoot(pkg);
    return root ? [path.join(root, 'skills')] : [];
  });
}

/** A shipped skill by name (`ver` is `version`). */
export function packagedSkill(name: string): PackagedSkill | null {
  const wanted = SKILL_ALIASES[name] ?? name;
  return packagedSkills().find((s) => s.name === wanted) ?? null;
}

/**
 * A file of a shipped skill (`version`, `scripts/version.mjs`). When the package is missing the path is
 * still returned, in the package's usual place, so callers that check `fs.existsSync` can say "reinstall pf".
 */
export function packagedSkillFile(skill: string, rel: string): string {
  const found = packagedSkill(skill);
  if (found) return path.join(found.dir, rel);
  const pkg = skill === 'version' || skill === 'ver' ? SKILL_PACKAGES[0]! : SKILL_PACKAGES[1]!;
  return path.join('node_modules', pkg, 'skills', SKILL_ALIASES[skill] ?? skill, rel);
}
