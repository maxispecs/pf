import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_URL } from '@pulpfixer/kit/constants';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { reporter } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { compareVersions } from '@pulpfixer/kit/util';
import { shortDescription } from './discover.js';
import {
  TARGET_IDS,
  inspectPath,
  installRemote,
  installedSkills,
  parseTargets,
  searchRemote,
  targetDir,
  targetLabel,
  viewRemote,
  type InstalledSkill,
  type RemoteSkill,
  type TargetId,
} from './registry.js';
import { STACK_SKILLS } from './stack.js';

const AUTH_HINT = 'Check NPM_TOKEN and the auth line in ~/.npmrc (pf setup fixes the latter)';

/** `1.4.0` -> `1.4`, the way the skills repo writes versions. */
const short = (v: string): string => v.replace(/^(\d+\.\d+)\.0$/, '$1');

/** Where installs go: `--to`, else pf's own folder. */
export function defaultTargets(flag?: string): TargetId[] | null {
  return flag ? parseTargets(flag) : ['pf'];
}

export function targetsHelp(): string {
  return TARGET_IDS.map((id) => `${id} (${targetLabel(id)})`).join(', ');
}

/** `pf skill available`: what the registry has, and what is installed here. */
export function listAvailable(home = os.homedir()): number {
  const c = out();
  const found = searchRemote();
  if (!found.skills) {
    process.stderr.write(`${badgeLabel('error', err())} could not search ${REGISTRY_URL}: ${found.error}\n${AUTH_HINT}\n`);
    return 1;
  }
  if (!found.skills.length) {
    process.stdout.write(`No @pf-skills packages on ${REGISTRY_URL}.\n`);
    return 0;
  }
  const installed = installedSkills(home);
  const width = Math.max(0, ...found.skills.map((s) => s.name.length));
  for (const s of found.skills) {
    const mine = installed.filter((i) => i.name === s.name);
    const state = !mine.length
      ? c.dim('not installed')
      : mine.some((i) => compareVersions(s.version, i.version) > 0)
        ? c.yellow(`update: ${mine.map((i) => `${i.target} v${short(i.version)}`).join(', ')}`)
        : c.green(`installed: ${mine.map((i) => i.target).join(', ')}`);
    process.stdout.write(`  ${c.bold(s.name.padEnd(width))}  v${short(s.version).padEnd(5)}  ${c.dim(shortDescription(s.description, 60))}  ${state}\n`);
  }
  process.stdout.write(`\n${c.dim('install:')} ${termLine('pf skill install <name>', c)}\n`);
  return 0;
}

/** `pf skill install <name...>`: latest version into each target folder. */
export function installSkills(names: string[], targets: TargetId[], opts: { dryRun?: boolean; force?: boolean; home?: string } = {}): number {
  const c = out();
  const r = reporter(c);
  let fails = 0;
  for (const name of names) {
    r.step(name);
    const found = viewRemote(name);
    if (!found.skill) {
      r.fail(found.error!);
      if (!/^no /.test(found.error!)) r.info(AUTH_HINT);
      fails++;
      continue;
    }
    fails += place(found.skill, targets, opts);
  }
  return fails ? 1 : 0;
}

function place(skill: RemoteSkill, targets: TargetId[], opts: { dryRun?: boolean; force?: boolean; home?: string }): number {
  const r = reporter(out());
  let fails = 0;
  for (const target of targets) {
    const dest = path.join(targetDir(target, opts.home), skill.name);
    const current = inspectPath(dest);
    const label = `${skill.package}@${short(skill.version)} -> ${dest}`;
    if ((current.kind === 'link' || current.kind === 'other') && !opts.force) {
      r.warn(`${dest} is ${current.kind === 'link' ? 'a symlink (a skills checkout?)' : 'not a registry install'}: left alone (--force replaces it)`);
      continue;
    }
    if (current.kind === 'registry' && current.package === skill.package && compareVersions(skill.version, current.version!) === 0) {
      r.ok(`${target}: v${short(skill.version)} is installed`);
      continue;
    }
    if (opts.dryRun) {
      r.info(`would install ${label}`);
      continue;
    }
    const done = installRemote(skill, dest, opts.force);
    if (done.ok) r.ok(`${target}: installed v${short(skill.version)}${current.version ? ` (was v${short(current.version)})` : ''}`);
    else {
      r.fail(`${target}: ${done.error}`);
      fails++;
    }
  }
  return fails;
}

/**
 * The stack skills (ver, pnpm) in pf's own folder: installed when missing, updated when older. A
 * symlinked checkout or a hand-made folder is left alone. `check` only reports.
 */
export function refreshStackSkills(opts: { check?: boolean; dryRun?: boolean; home?: string } = {}): number {
  if (!opts.check) return installSkills([...STACK_SKILLS], ['pf'], { dryRun: opts.dryRun, home: opts.home });
  const r = reporter(out());
  let fails = 0;
  for (const name of STACK_SKILLS) {
    const found = viewRemote(name);
    if (!found.skill) {
      r.fail(`${name}: ${found.error}`);
      fails++;
      continue;
    }
    const mine = inspectPath(path.join(targetDir('pf', opts.home), name));
    if (mine.kind === 'missing') r.warn(`${name} v${short(found.skill.version)} is available (not installed in ${targetLabel('pf')})`);
    else if (mine.kind !== 'registry') r.info(`${name}: ${mine.kind === 'link' ? 'a symlink' : 'not a registry install'} in ${targetLabel('pf')}, left alone`);
    else if (compareVersions(found.skill.version, mine.version!) > 0) r.warn(`${name} v${short(found.skill.version)} is available (you have v${short(mine.version!)})`);
    else r.ok(`${name} v${short(mine.version!)} is the latest`);
  }
  if (fails) r.info(AUTH_HINT);
  return fails ? 1 : 0;
}

/**
 * `pf skill update [name...]` and the skills step of `pf update`: bring every registry install
 * (or the named ones) to the latest version. `check` only reports.
 */
export function updateSkills(
  names: string[],
  opts: { check?: boolean; dryRun?: boolean; home?: string; skipStack?: boolean } = {},
): number {
  const c = out();
  const r = reporter(c);
  // `skipStack`: the stack skills in pf's folder were just handled by refreshStackSkills.
  const all = installedSkills(opts.home).filter((s) => !(opts.skipStack && s.target === 'pf' && STACK_SKILLS.includes(s.name)));
  const chosen = names.length ? all.filter((s) => names.includes(s.name)) : all;
  const unknown = names.filter((n) => !all.some((s) => s.name === n));
  for (const n of unknown) r.warn(`${n} is not installed from the registry (pf skill install ${n})`);
  if (!chosen.length) {
    if (!names.length && !opts.skipStack) r.info(`no skills installed from the registry (see ${'pf skill available'})`);
    return unknown.length ? 1 : 0;
  }
  const latest = new Map<string, RemoteSkill | string>();
  let fails = 0;
  for (const s of chosen) {
    if (!latest.has(s.package)) {
      const found = viewRemote(s.package);
      latest.set(s.package, found.skill ?? found.error!);
    }
    const remote = latest.get(s.package)!;
    if (typeof remote === 'string') {
      r.fail(`${s.name} (${s.target}): ${remote}`);
      fails++;
      continue;
    }
    if (compareVersions(remote.version, s.version) <= 0) {
      r.ok(`${s.name} (${s.target}) v${short(s.version)} is the latest`);
      continue;
    }
    if (opts.check) {
      r.warn(`${s.name} (${s.target}) v${short(remote.version)} is available (you have v${short(s.version)})`);
      continue;
    }
    fails += place(remote, [s.target], { dryRun: opts.dryRun, home: opts.home });
  }
  if (fails) r.info(AUTH_HINT);
  return fails || unknown.length ? 1 : 0;
}

/** `pf skill remove <name...>`: delete registry installs only, never a symlink or a hand-made folder. */
export function removeSkills(names: string[], targets: TargetId[] | null, opts: { dryRun?: boolean; home?: string } = {}): number {
  const r = reporter(out());
  let fails = 0;
  const all: InstalledSkill[] = installedSkills(opts.home);
  for (const name of names) {
    const hits = all.filter((s) => s.name === name && (!targets || targets.includes(s.target)));
    if (!hits.length) {
      r.warn(`${name}: no registry install${targets ? ` in ${targets.join(', ')}` : ''}`);
      fails++;
      continue;
    }
    for (const s of hits) {
      if (opts.dryRun) r.info(`would remove ${s.dir}`);
      else {
        fs.rmSync(s.dir, { recursive: true, force: true });
        r.ok(`removed ${s.dir}`);
      }
    }
  }
  return fails ? 1 : 0;
}
