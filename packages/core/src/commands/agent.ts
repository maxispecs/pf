import { writeCursorMcp } from '../agent/adapters.js';
import { saveAgent } from '../agent/agents.js';
import { chooseSavedAgent, startAgent } from '../agent/launch.js';
import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { splitDashes, takeFlag, takeOption, which } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';

export const agentCommand: Command = {
  name: 'agent',
  summary: 'Open the coding agent (Claude Code, Codex or Cursor)',
  group: 'Agent',
  usage: 'pf agent [prompt...] [--agent claude|codex|cursor] [--profile <name>] [--dry-run]',
  async run(ctx, args) {
    const [before, after] = splitDashes([...args]);
    const dryRun = takeFlag(before, '--dry-run', '-n');
    if (before[0] === 'use') return useAgent(before.slice(1), dryRun);
    const agent = takeOption(before, '--agent');
    const profile = takeOption(before, '--profile');
    const prompt = [...before, ...after].join(' ').trim();
    return startAgent(ctx, { prompt, ...(agent !== undefined ? { agent } : {}), ...(profile ? { profile } : {}), dryRun });
  },
};

/** `pf agent use [id]` sets the default agent. Choosing cursor also registers the pf MCP server. */
async function useAgent(args: string[], dryRun: boolean): Promise<number> {
  const c = err();
  const chosen = await chooseSavedAgent(args[0]);
  const info = chosen.agent;
  if (!info) return chosen.code;
  if (!which(info.bin)) {
    process.stderr.write(`${badgeLabel('error', c)} ${info.label} (${info.bin}) is not on PATH.\n`);
    return 1;
  }
  if (dryRun) {
    process.stderr.write(`${c.dim('would set the agent to')} ${info.label}\n`);
    if (info.id === 'cursor') process.stderr.write(`${c.dim('would add the pulpfixer MCP server to ~/.cursor/mcp.json')}\n`);
    return 0;
  }
  if (!saveAgent(info.id)) {
    process.stderr.write(`${badgeLabel('error', c)} could not write ~/.pf/config.json\n`);
    return 1;
  }
  process.stderr.write(`${c.dim('pf agent will use')} ${termLine(info.label, c)}\n`);
  if (info.id === 'cursor') {
    if (writeCursorMcp()) process.stderr.write(`${c.dim('added pulpfixer to')} ~/.cursor/mcp.json\n`);
    else process.stderr.write(`${badgeLabel('warning', c)} the agent is saved, but ~/.cursor/mcp.json could not be written\n`);
  }
  return 0;
}
