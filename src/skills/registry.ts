import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_URL } from '../constants.js';
import { capture } from '../exec.js';
import { readJson } from '../util.js';
import { PF_SKILLS_LABEL, parseSkillFile, pfSkillsDir } from './discover.js';

/**
 * Skills published from the skills repo (`pnpm publish:cellars` there):
 *   default      @pf-skills/<name>
 *   own package  @pf-skills-<name>/<name>
 * The tarball is the skill directory plus a generated package.json, which stays in the installed
 * copy and marks it as a registry install.
 */
export const SKILL_SCOPE = '@pf-skills';

const NAME = '[a-z0-9]+(?:-[a-z0-9]+)*';
const PACKAGE_RE = new RegExp(`^${SKILL_SCOPE}(?:-${NAME})?/(${NAME})$`);

export function isSkillPackage(name: string): boolean {
  return PACKAGE_RE.test(name);
}

/** `@pf-skills-ver/ver` -> `ver`. */
export function skillOfPackage(name: string): string | null {
  return PACKAGE_RE.exec(name)?.[1] ?? null;
}

/** Package names a skill may be published under, most likely first. */
export function candidatePackages(skill: string): string[] {
  if (isSkillPackage(skill)) return [skill];
  return [`${SKILL_SCOPE}/${skill}`, `${SKILL_SCOPE}-${skill}/${skill}`];
}

/** Where installs go: pf's own folder (the default), or an agent's skills folder. */
export const TARGET_IDS = ['pf', 'cursor', 'claude', 'agents'] as const;

export type TargetId = (typeof TARGET_IDS)[number];

const AGENT_FOLDERS: Record<Exclude<TargetId, 'pf'>, string> = {
  cursor: '.cursor/skills',
  claude: '.claude/skills',
  agents: '.agents/skills',
};

export function targetDir(id: TargetId, home = os.homedir()): string {
  return id === 'pf' ? pfSkillsDir() : path.join(home, AGENT_FOLDERS[id]);
}

export function targetLabel(id: TargetId): string {
  return id === 'pf' ? PF_SKILLS_LABEL : `~/${AGENT_FOLDERS[id]}`;
}

/** Parse `--to pf,claude` / `all`. Returns null on an unknown name. */
export function parseTargets(value: string): TargetId[] | null {
  if (value.trim() === 'all') return [...TARGET_IDS];
  const aliases: Record<string, TargetId> = { pulpfixer: 'pf', 'cursor-agent': 'cursor', 'claude-code': 'claude' };
  const out: TargetId[] = [];
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const id = (aliases[part] ?? part) as TargetId;
    if (!TARGET_IDS.includes(id)) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out.length ? out : null;
}

export interface RemoteSkill {
  name: string;
  package: string;
  version: string;
  description: string;
}

function npmError(stderr: string): string {
  const m = stderr.match(/npm (?:error|ERR!) (?:code )?(E\w+|\d{3}[^\n]*)/)?.[1];
  return (m ?? stderr.trim().split('\n')[0] ?? '').trim() || 'registry unreachable';
}

/** Keep the registry's skill packages, one per skill name (an own package wins over the default one). */
export function pickSkillPackages(results: { name?: unknown; version?: unknown; description?: unknown }[]): RemoteSkill[] {
  const byName = new Map<string, RemoteSkill>();
  for (const r of results) {
    if (typeof r.name !== 'string' || typeof r.version !== 'string') continue;
    const name = skillOfPackage(r.name);
    if (!name) continue;
    const prev = byName.get(name);
    if (prev && !prev.package.startsWith(`${SKILL_SCOPE}/`)) continue;
    byName.set(name, { name, package: r.name, version: r.version, description: typeof r.description === 'string' ? r.description : '' });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse `npm search --json` output, which may carry notices before the array. */
export function parseSearch(stdout: string): { name?: unknown; version?: unknown; description?: unknown }[] {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Every skill on the registry, from `npm search`. */
export function searchRemote(timeoutMs = 30_000): { skills?: RemoteSkill[]; error?: string } {
  const r = capture(['npm', 'search', SKILL_SCOPE.slice(1), '--json', '--searchlimit', '250', '--registry', REGISTRY_URL], {
    timeout: timeoutMs,
    cwd: os.tmpdir(),
  });
  if (!r.ok) return { error: npmError(r.stderr) };
  return { skills: pickSkillPackages(parseSearch(r.stdout)) };
}

/** Latest version of one skill. Tries the default package, then the skill's own package. */
export function viewRemote(skillOrPackage: string, timeoutMs = 20_000): { skill?: RemoteSkill; error?: string } {
  let error = '';
  for (const pkg of candidatePackages(skillOrPackage)) {
    const r = capture(['npm', 'view', pkg, 'name', 'version', 'description', '--json', '--registry', REGISTRY_URL], {
      timeout: timeoutMs,
      cwd: os.tmpdir(),
    });
    if (r.ok) {
      try {
        const v = JSON.parse(r.stdout) as { name?: string; version?: string; description?: string };
        if (v.version) return { skill: { name: skillOfPackage(pkg)!, package: pkg, version: v.version, description: v.description ?? '' } };
      } catch {
        // fall through to the next candidate
      }
    }
    error = npmError(r.stderr);
    if (!/E404|404/.test(error)) break;
  }
  return { error: /E404|404/.test(error) ? `no ${candidatePackages(skillOrPackage).join(' or ')} on the registry` : error };
}

export interface InstalledSkill {
  name: string;
  package: string;
  version: string;
  dir: string;
  target: TargetId;
}

/** What sits at a skill's install path. Symlinks (a skills repo checkout) and other folders are not ours to replace. */
export function inspectPath(dir: string): { kind: 'missing' | 'registry' | 'link' | 'other'; package?: string; version?: string } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return { kind: 'missing' };
  }
  if (st.isSymbolicLink()) return { kind: 'link' };
  const pkg = readJson<{ name?: string; version?: string }>(dir, 'package.json');
  if (st.isDirectory() && pkg?.name && isSkillPackage(pkg.name)) return { kind: 'registry', package: pkg.name, version: pkg.version ?? '0.0.0' };
  return { kind: 'other' };
}

/** Skills installed from the registry, across every target folder. */
export function installedSkills(home = os.homedir()): InstalledSkill[] {
  const found: InstalledSkill[] = [];
  for (const target of TARGET_IDS) {
    const root = targetDir(target, home);
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const dir = path.join(root, name);
      const info = inspectPath(dir);
      if (info.kind === 'registry') found.push({ name, package: info.package!, version: info.version!, dir, target });
    }
  }
  return found;
}

/**
 * Put an extracted package (a folder holding SKILL.md) at `dest`, replacing a previous registry
 * install. Refuses anything else at `dest` unless `force`. The swap keeps the old copy until the
 * new one is in place.
 */
export function placeSkill(extracted: string, dest: string, force = false): void {
  if (!fs.existsSync(path.join(extracted, 'SKILL.md'))) throw new Error('the package has no SKILL.md');
  const current = inspectPath(dest);
  if ((current.kind === 'link' || current.kind === 'other') && !force) {
    throw new Error(`${dest} exists and was not installed from the registry (${current.kind === 'link' ? 'a symlink' : 'a folder'}); pass --force to replace it`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const old = `${dest}.pf-old-${process.pid}`;
  if (current.kind !== 'missing') fs.renameSync(dest, old);
  try {
    fs.renameSync(extracted, dest);
  } catch (e) {
    if (current.kind !== 'missing') fs.renameSync(old, dest);
    throw e;
  }
  if (current.kind !== 'missing') fs.rmSync(old, { recursive: true, force: true });
}

/** Extract an npm tarball (`package/...`) into a fresh folder next to `dest` and place it there. */
export function installTarball(tarball: string, dest: string, force = false): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const work = fs.mkdtempSync(path.join(path.dirname(dest), `.${path.basename(dest)}.pf-new-`));
  try {
    const r = capture(['tar', '-xzf', tarball, '-C', work], { timeout: 60_000 });
    if (!r.ok) throw new Error(`could not extract ${path.basename(tarball)}: ${r.stderr.trim() || 'tar failed'}`);
    const extracted = path.join(work, 'package');
    const name = parseSkillFile(fs.readFileSync(path.join(extracted, 'SKILL.md'), 'utf8'), path.basename(dest)).name;
    if (name !== path.basename(dest)) throw new Error(`the package's SKILL.md is named "${name}", expected "${path.basename(dest)}"`);
    placeSkill(extracted, dest, force);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Download `<package>@<version>` and install it as `<target folder>/<skill>`. */
export function installRemote(skill: RemoteSkill, dest: string, force = false): { ok: true } | { ok: false; error: string } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-skill-'));
  try {
    const r = capture(['npm', 'pack', `${skill.package}@${skill.version}`, '--json', '--pack-destination', work, '--registry', REGISTRY_URL], {
      cwd: work,
      timeout: 120_000,
    });
    if (!r.ok) return { ok: false, error: npmError(r.stderr) };
    const tarball = fs.readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (!tarball) return { ok: false, error: 'npm pack wrote no tarball' };
    installTarball(path.join(work, tarball), dest, force);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
