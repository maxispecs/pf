import { userConfigPath, writeHomeFile } from '../config.js';
import { readJson, which } from '../util.js';

export type AgentId = 'claude' | 'codex' | 'cursor';

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** Binary on PATH. */
  bin: string;
  /** Other names accepted in config, flags and PF_AGENT. */
  aliases: string[];
}

/** Supported agent CLIs, in auto-detect order. */
export const AGENTS: AgentInfo[] = [
  { id: 'cursor', label: 'Cursor', bin: 'cursor-agent', aliases: ['cursor-agent'] },
  { id: 'claude', label: 'Claude Code', bin: 'claude', aliases: ['claude-code', 'claudecode'] },
  { id: 'codex', label: 'Codex', bin: 'codex', aliases: ['openai-codex'] },
];

export const AGENT_IDS = AGENTS.map((a) => a.id);

export function agentInfo(name: string | undefined): AgentInfo | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  return AGENTS.find((a) => a.id === n || a.bin === n || a.aliases.includes(n));
}

export function installedAgents(isInstalled: (bin: string) => boolean = (b) => Boolean(which(b))): AgentInfo[] {
  return AGENTS.filter((a) => isInstalled(a.bin));
}

export interface AgentChoice {
  agent: AgentInfo | null;
  /** Where the choice came from. */
  source: 'flag' | 'env' | 'config' | 'detected' | 'none';
  /** The name that was asked for, when one was. */
  requested?: string;
  /** A name was asked for but is not a known agent. */
  unknown?: boolean;
  /** The chosen agent is not on PATH. */
  missing?: boolean;
}

/** Pick the agent CLI: `--agent`, then PF_AGENT, then `agent` in ~/.pf/config.json, then the first installed. */
export function resolveAgent(opts: {
  flag?: string | undefined;
  env?: string | undefined;
  configured?: string | undefined;
  isInstalled?: (bin: string) => boolean;
}): AgentChoice {
  const isInstalled = opts.isInstalled ?? ((b: string) => Boolean(which(b)));
  const asked: [AgentChoice['source'], string | undefined][] = [
    ['flag', opts.flag],
    ['env', opts.env],
    ['config', opts.configured],
  ];
  for (const [source, name] of asked) {
    if (!name) continue;
    const agent = agentInfo(name);
    if (!agent) return { agent: null, source, requested: name, unknown: true };
    return { agent, source, requested: name, ...(isInstalled(agent.bin) ? {} : { missing: true }) };
  }
  const found = installedAgents(isInstalled)[0];
  return found ? { agent: found, source: 'detected' } : { agent: null, source: 'none' };
}

/** Save the default agent in ~/.pf/config.json, keeping the other keys. */
export function saveAgent(id: AgentId): boolean {
  const current = readJson<Record<string, unknown>>(userConfigPath()) ?? {};
  return writeHomeFile('config.json', JSON.stringify({ ...current, agent: id }, null, 2) + '\n');
}
