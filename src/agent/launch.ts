import fs from 'node:fs';
import path from 'node:path';
import { pfHome } from '../constants.js';
import { writeHomeFile } from '../config.js';
import type { Context } from '../context.js';
import { runCmd } from '../exec.js';
import { err } from '../ui/palette.js';
import { pick } from '../ui/picker.js';
import { confirm } from '../ui/prompt.js';
import { badgeLabel, termLine } from '../ui/text.js';
import { interactive } from '../util.js';
import { buildLaunch, cursorMcpPath, cursorMcpRegistered, writeCursorMcp } from './adapters.js';
import { agentInfo, installedAgents, resolveAgent, saveAgent, type AgentChoice, type AgentInfo } from './agents.js';
import { buildPersona } from './persona.js';
import { loadAgentSkills } from './tools.js';

export interface StartOptions {
  prompt?: string;
  /** `--agent` value. */
  agent?: string;
  dryRun?: boolean;
}

function agentError(choice: AgentChoice): string {
  const c = err();
  if (choice.unknown) return `${badgeLabel('error', c)} "${choice.requested}" is not an agent. Use claude, codex or cursor (${termLine('pf agent use', c)}).`;
  if (choice.missing) return `${badgeLabel('error', c)} ${choice.agent!.label} is not on PATH. Install ${choice.agent!.bin}, or choose another with ${termLine('pf agent use', c)}.`;
  return `${badgeLabel('error', c)} no agent CLI found (cursor-agent, claude or codex). Install one, or set it with ${termLine('pf agent use', c)}.`;
}

/** The configured agent, or a picker the first time a terminal has several CLIs installed. Null means cancelled. */
async function resolveForLaunch(ctx: Context, opts: StartOptions): Promise<AgentChoice | null> {
  const explicit = Boolean(opts.agent || process.env.PF_AGENT || ctx.user.agent);
  if (!explicit && !opts.dryRun && interactive()) {
    const installed = installedAgents();
    if (installed.length > 1) {
      const picked = await pick(
        'Which agent should pf use?',
        installed.map((a) => ({ value: a, label: a.label, hint: a.bin })),
      );
      if (!picked) return null;
      if (!saveAgent(picked.id)) process.stderr.write(`${badgeLabel('warning', err())} could not save the choice to ~/.pf/config.json\n`);
      return { agent: picked, source: 'config' };
    }
  }
  return resolveAgent({ flag: opts.agent, env: process.env.PF_AGENT, configured: ctx.user.agent });
}

function writeLaunchFiles(files: { path: string; contents: string }[]): boolean {
  const c = err();
  const home = pfHome();
  for (const f of files) {
    const rel = path.relative(home, f.path);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (inside) {
      if (!writeHomeFile(rel, f.contents)) {
        process.stderr.write(`${badgeLabel('error', c)} could not write ${f.path}\n`);
        return false;
      }
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.contents);
    } catch (e) {
      process.stderr.write(`${badgeLabel('error', c)} could not write ${f.path}: ${e instanceof Error ? e.message : String(e)}\n`);
      return false;
    }
  }
  return true;
}

/** Offer to register the pf MCP server with Cursor. `pf agent use cursor` is itself the consent. */
async function ensureCursorMcp(dryRun: boolean): Promise<void> {
  if (cursorMcpRegistered()) return;
  const c = err();
  const file = cursorMcpPath();
  if (dryRun) {
    process.stderr.write(`${c.dim('would add pulpfixer to')} ${file} ${c.dim('(asks first)')}\n`);
    return;
  }
  const yes = interactive() && (await confirm(`Add the pulpfixer tools to ${file}?`, true));
  if (yes && writeCursorMcp(file)) {
    process.stderr.write(`${c.dim('added pulpfixer to')} ${file}\n`);
    return;
  }
  if (yes) process.stderr.write(`${badgeLabel('warning', c)} could not write ${file}\n`);
  process.stderr.write(`${c.dim('Cursor will not see pf tools until you run')} ${termLine('pf agent use cursor', c)}\n`);
}

/** Launch the chosen agent CLI with the pf persona, tools and skills. */
export async function startAgent(ctx: Context, opts: StartOptions = {}): Promise<number> {
  const c = err();
  const choice = await resolveForLaunch(ctx, opts);
  if (!choice) return 130;
  if (!choice.agent || choice.unknown || choice.missing) {
    process.stderr.write(agentError(choice) + '\n');
    return 1;
  }
  if (choice.source === 'detected' && !interactive()) {
    process.stderr.write(`${c.dim(`using ${choice.agent.label} (auto-detected). Choose one with`)} ${termLine('pf agent use', c)}\n`);
  }
  if (choice.agent.id === 'cursor') await ensureCursorMcp(Boolean(opts.dryRun));
  const persona = buildPersona(ctx, loadAgentSkills(ctx));
  const launch = buildLaunch(choice.agent, { persona, prompt: opts.prompt ?? '', cwd: ctx.workdir });
  if (opts.dryRun) process.stderr.write(`${c.bold('persona')}\n${persona}\n`);
  else if (!writeLaunchFiles(launch.files)) return 1;
  return runCmd({ argv: launch.argv, cwd: ctx.workdir }, { dryRun: opts.dryRun, base: ctx.workdir });
}

/** The agent to save. `code` is the exit status when no agent was chosen. */
export async function chooseSavedAgent(name: string | undefined): Promise<{ agent: AgentInfo | null; code: number }> {
  const c = err();
  if (name) {
    const info = agentInfo(name);
    if (!info) {
      process.stderr.write(`${badgeLabel('error', c)} "${name}" is not an agent. Use claude, codex or cursor.\n`);
      return { agent: null, code: 2 };
    }
    return { agent: info, code: 0 };
  }
  const installed = installedAgents();
  if (installed.length === 0) {
    process.stderr.write(`${badgeLabel('error', c)} no agent CLI found (cursor-agent, claude or codex).\n`);
    return { agent: null, code: 1 };
  }
  if (!interactive()) {
    process.stderr.write(`Installed agents: ${installed.map((a) => a.id).join(', ')}\nPass one to ${termLine('pf agent use <id>', c)}.\n`);
    return { agent: null, code: 2 };
  }
  const picked = await pick(
    'Which agent should pf use?',
    installed.map((a) => ({ value: a, label: a.label, hint: a.bin })),
  );
  return picked ? { agent: picked, code: 0 } : { agent: null, code: 130 };
}
