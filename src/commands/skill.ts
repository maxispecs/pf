import type { Context } from '../context.js';
import { discoverSkills, shortDescription, type Skill } from '../skills/discover.js';
import { defaultTargets, installSkills, listAvailable, removeSkills, targetsHelp, updateSkills } from '../skills/manage.js';
import { searchRemote } from '../skills/registry.js';
import { runSkill } from '../skills/run.js';
import { err, out } from '../ui/palette.js';
import { pick } from '../ui/picker.js';
import { badgeLabel, termLine } from '../ui/text.js';
import { interactive, takeFlag, takeOption } from '../util.js';
import type { Command } from './types.js';

export function loadSkills(ctx: Context): Skill[] {
  return discoverSkills(ctx.repo?.root ?? null, ctx.user);
}

/** Interactive searchable skill picker. Returns null when cancelled or without a terminal. */
export async function pickSkill(ctx: Context): Promise<Skill | null> {
  const skills = loadSkills(ctx);
  if (skills.length === 0) return null;
  return pick(
    'Run a skill',
    skills.map((s) => ({ value: s, label: s.name, hint: shortDescription(s.description) })),
    { search: true },
  );
}

export function printSkills(skills: Skill[]): void {
  const c = out();
  const width = Math.max(0, ...skills.map((s) => s.name.length));
  for (const s of skills) {
    process.stdout.write(`  ${c.bold(s.name.padEnd(width))}  ${c.dim(shortDescription(s.description, 80))}  ${c.dim('[' + s.source + ']')}\n`);
  }
}

/** Registry subcommands. Their names are reserved: a skill called "install" runs as `pf skill run install`. */
export const SKILL_SUBCOMMANDS = ['available', 'install', 'update', 'remove', 'run'] as const;

async function registryCommand(ctx: Context, sub: string, rest: string[], dryRun: boolean): Promise<number> {
  const c = err();
  const to = takeOption(rest, '--to');
  const force = takeFlag(rest, '--force', '-f');
  const all = takeFlag(rest, '--all', '-a');
  const check = takeFlag(rest, '--check');
  const unknownFlag = rest.find((a) => a.startsWith('-'));
  if (unknownFlag) {
    process.stderr.write(`${badgeLabel('error', c)} unknown option ${unknownFlag}\n`);
    return 1;
  }
  const names = rest.map((n) => n.replace(/^\//, ''));
  if (sub === 'available') return listAvailable();
  if (sub === 'update') return updateSkills(names, { check, dryRun });
  const targets = sub === 'remove' && !to ? null : defaultTargets(to);
  if (targets === null && to) {
    process.stderr.write(`${badgeLabel('error', c)} --to takes ${targetsHelp()} or all\n`);
    return 1;
  }
  if (sub === 'remove') {
    if (!names.length) {
      process.stderr.write(`${badgeLabel('error', c)} name the skills to remove: ${termLine('pf skill remove <name...>', c)}\n`);
      return 1;
    }
    return removeSkills(names, targets, { dryRun });
  }
  let wanted = names;
  if (all) {
    const found = searchRemote();
    if (!found.skills) {
      process.stderr.write(`${badgeLabel('error', c)} could not search the registry: ${found.error}\n`);
      return 1;
    }
    wanted = found.skills.map((s) => s.name);
  }
  if (!wanted.length) {
    process.stderr.write(`${badgeLabel('error', c)} name the skills to install, or pass --all. ${termLine('pf skill available', c)} lists them.\n`);
    return 1;
  }
  return installSkills(wanted, targets!, { dryRun, force });
}

export const skillCommand: Command = {
  name: 'skill',
  summary: 'Run an agent skill',
  group: 'Tools',
  usage: 'pf skill [name] [args...] [--list] [--dry-run] | available | install <name...>|--all [--to <agent>] | update [name...] [--check] | remove <name...>',
  async run(ctx, args) {
    const c = err();
    const rest = [...args];
    const list = takeFlag(rest, '--list', '-l');
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const sub = rest[0];
    if (sub && sub !== 'run' && (SKILL_SUBCOMMANDS as readonly string[]).includes(sub)) return registryCommand(ctx, sub, rest.slice(1), dryRun);
    if (sub === 'run') rest.shift();
    const skills = loadSkills(ctx);
    if (skills.length === 0) {
      process.stderr.write(`${badgeLabel('error', c)} no skills found (looked in ~/.cursor/skills, ~/.agents/skills, ~/.claude/skills, ~/.pf/skills and the repo). ${termLine('pf skill available', c)} lists the registry's.\n`);
      return 1;
    }
    if (list || (rest.length === 0 && !interactive())) {
      printSkills(skills);
      return 0;
    }
    let skill: Skill | null | undefined;
    if (rest.length === 0) {
      skill = await pickSkill(ctx);
      if (!skill) return 130;
      process.stderr.write(`${c.dim('next time:')} ${termLine(`pf skill ${skill.name}`, c)}\n`);
    } else {
      const name = rest.shift()!.replace(/^\//, '');
      skill = skills.find((s) => s.name === name);
      if (!skill) {
        const near = skills.filter((s) => s.name.includes(name)).map((s) => s.name);
        process.stderr.write(`${badgeLabel('error', c)} no skill named "${name}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}\n`);
        return 1;
      }
    }
    return runSkill(ctx, skill, rest, dryRun);
  },
};
