import path from 'node:path';
import { resolveAgent } from '../agent/agents.js';
import { startAgent } from '../agent/launch.js';
import type { Context } from '../context.js';
import { runCmd, type Cmd } from '../exec.js';
import { verCommand } from '../commands/ver.js';
import { err } from '../ui/palette.js';
import { badgeLabel, termLine } from '../ui/text.js';
import { exists } from '../util.js';
import { BUNDLED_LABEL, type Skill } from './discover.js';

export function agentPrompt(agent: string, skill: string, args: string[]): string {
  const rest = args.join(' ').trim();
  if (agent === 'codex') return `Use the ${skill} skill${rest ? `: ${rest}` : '.'}`;
  return `/${skill}${rest ? ` ${rest}` : ''}`;
}

export function agentCommand(agent: string, skill: string, args: string[], cwd: string): Cmd {
  return { argv: [agent, agentPrompt(agent, skill, args)], cwd };
}

/**
 * Skills with a deterministic script run directly. Everything else goes through an agent CLI.
 * Returns null when the skill is not a direct one.
 */
export async function runDirect(ctx: Context, skill: Skill, args: string[], dryRun: boolean): Promise<number | null> {
  const c = err();
  if (skill.name === 'ver') {
    return dryRun ? (process.stderr.write(`${c.dim('would run')} ${termLine('pf ver ' + args.join(' '), c)}\n`), 0) : verCommand.run(ctx, args);
  }
  if (skill.name === 'pnpm') {
    const script = path.join(skill.dir, 'scripts', 'tasks.mjs');
    if (!exists(script)) return null;
    if (!exists(ctx.workdir, 'package.json')) {
      process.stderr.write(`${badgeLabel('warning', c)} /pnpm is for Node repos (no package.json here). pf already lists commands for other stacks: run ${termLine('pf', c)}.\n`);
      return 1;
    }
    return runCmd({ argv: [process.execPath, script, ...(args.length ? args : ['setup'])], cwd: ctx.workdir }, { dryRun, base: ctx.workdir });
  }
  return null;
}

/** Run a skill: direct script when there is one, otherwise hand off to the agent CLI. */
export async function runSkill(ctx: Context, skill: Skill, args: string[], dryRun = false): Promise<number> {
  const direct = await runDirect(ctx, skill, args, dryRun);
  if (direct !== null) return direct;
  if (skill.source === BUNDLED_LABEL) {
    const rest = args.join(' ').trim();
    return startAgent(ctx, { prompt: `Call pf_skill with name "${skill.name}" and follow it.${rest ? ` Task: ${rest}` : ''}`, dryRun });
  }
  const c = err();
  const choice = resolveAgent({ env: process.env.PF_AGENT, configured: ctx.user.agent });
  if (!choice.agent || choice.missing) {
    process.stderr.write(
      `${badgeLabel('error', c)} ${choice.requested ? `agent "${choice.requested}" is ${choice.unknown ? 'not a known agent' : 'not on PATH'}` : 'no agent CLI found (cursor-agent, claude or codex)'}.\n` +
        `The skill lives at ${path.join(skill.dir, 'SKILL.md')}. Install an agent CLI, or choose one with ${termLine('pf agent use', c)}.\n`,
    );
    return 1;
  }
  return runCmd(agentCommand(choice.agent.bin, skill.name, args, ctx.workdir), { dryRun, base: ctx.workdir });
}
