import type { Context } from '../context.js';
import { discoverSkills, shortDescription, type Skill } from '../skills/discover.js';
import { runSkill } from '../skills/run.js';
import { err, out } from '../ui/palette.js';
import { pick } from '../ui/picker.js';
import { interactive, takeFlag } from '../util.js';
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

export const skillCommand: Command = {
  name: 'skill',
  summary: 'Run an agent skill',
  group: 'Tools',
  usage: 'pf skill [name] [args...] [--list] [--dry-run]',
  async run(ctx, args) {
    const c = err();
    const rest = [...args];
    const list = takeFlag(rest, '--list', '-l');
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const skills = loadSkills(ctx);
    if (skills.length === 0) {
      process.stderr.write(`${c.red('error:')} no skills found (looked in ~/.cursor/skills, ~/.agents/skills, ~/.claude/skills and the repo).\n`);
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
    } else {
      const name = rest.shift()!.replace(/^\//, '');
      skill = skills.find((s) => s.name === name);
      if (!skill) {
        const near = skills.filter((s) => s.name.includes(name)).map((s) => s.name);
        process.stderr.write(`${c.red('error:')} no skill named "${name}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}\n`);
        return 1;
      }
    }
    return runSkill(ctx, skill, rest, dryRun);
  },
};
