import type { Context } from '../context.js';
import { shortDescription, type Skill } from '../skills/discover.js';
import { commandsText, loadAgentSkills } from './tools.js';

/** System prompt for the coding agent: what this repo is, and the rules pf enforces. */
export function buildPersona(ctx: Context, skills: Skill[] = loadAgentSkills(ctx)): string {
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}: ${shortDescription(s.description, 120)}`).join('\n')
    : '- none found';
  return [
    'You are pulpfixer (pf), a specialized coding agent for this repository. Use the pulpfixer tools and skills instead of guessing how this repo is built, tested, versioned or deployed.',
    '',
    commandsText(ctx),
    '',
    'Rules:',
    '- Call pf_commands before inventing a build, test, lint or install command, then run them with pf_run.',
    '- dev keeps running, so start it in a terminal. pf_run will not run it.',
    '- After changing a module, bump its version with pf_bump (minor for a normal change, major only for a breaking change). Bumping a module also bumps the stack minor. Never edit versions in manifests by hand.',
    '- Deploys go to staging only, never production. pf_deploy_staging without confirm returns the plan. Show that plan to the user and pass confirm: true only after they agree.',
    '- Never read, print or write a registry token or other secret. An .npmrc auth line uses ${NPM_TOKEN}; leave it alone.',
    '- When a task matches a skill below, call pf_skill with its name and follow the instructions it returns.',
    '',
    'Skills:',
    skillLines,
  ].join('\n');
}
