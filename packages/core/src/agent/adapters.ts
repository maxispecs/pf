import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pfHome } from '@pulpfixer/kit/constants';
import { readJson } from '@pulpfixer/kit/util';
import type { AgentInfo } from './agents.js';
import { SERVER_NAME } from './mcp.js';
import { TOOLS } from './tools.js';

export interface LaunchFile {
  path: string;
  contents: string;
}

export interface Launch {
  argv: string[];
  /** Written before the CLI starts. Empty for a dry run. */
  files: LaunchFile[];
}

export interface LaunchInput {
  persona: string;
  /** The user's task. Empty starts an interactive session. */
  prompt: string;
  cwd: string;
  /** argv of `pf mcp`. Defaults to this process, so `pnpm dev` and a built install both work. */
  serverArgv?: string[];
  /** Claude reads the MCP server from here. */
  mcpConfigPath?: string;
}

/** argv that serves pf tools: this executable, plus `mcp`, plus the repo when one is known. */
export function mcpServerArgv(cwd?: string): string[] {
  const argv = [process.execPath, ...process.execArgv, process.argv[1] ?? '', 'mcp'];
  if (cwd) argv.push('--cwd', cwd);
  return argv;
}

export function claudeMcpConfigPath(): string {
  return path.join(pfHome(), 'agent', 'mcp.json');
}

function mcpJson(serverArgv: string[]): string {
  const [command, ...args] = serverArgv;
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }, null, 2) + '\n';
}

/** Read-only pf tools an agent CLI may run without asking. Writes and deploys stay behind its own prompt. */
function claudeAllowedTools(): string[] {
  return TOOLS.filter((t) => t.readOnly).map((t) => `mcp__${SERVER_NAME}__${t.name}`);
}

/**
 * How to start one agent CLI with the pf persona and the pf MCP server.
 * Claude takes the persona as a system prompt (flags checked against `claude --help`).
 * Codex takes MCP servers through `-c`; its `--help` could not be run here (the packaged
 * binary was missing), so the persona is placed in front of the prompt, which Codex reads.
 * Cursor has no system-prompt flag (`cursor-agent --help`), so the persona leads the prompt,
 * and the MCP server is registered separately in ~/.cursor/mcp.json.
 */
export function buildLaunch(agent: AgentInfo, input: LaunchInput): Launch {
  const serverArgv = input.serverArgv ?? mcpServerArgv(input.cwd);
  const prompt = input.prompt.trim();
  if (agent.id === 'claude') {
    const configPath = input.mcpConfigPath ?? claudeMcpConfigPath();
    const argv = [
      agent.bin,
      '--mcp-config',
      configPath,
      '--append-system-prompt',
      input.persona,
      ...claudeAllowedTools().flatMap((t) => ['--allowedTools', t]),
    ];
    if (prompt) argv.push(prompt);
    return { argv, files: [{ path: configPath, contents: mcpJson(serverArgv) }] };
  }
  if (agent.id === 'codex') {
    const [command, ...args] = serverArgv;
    const argv = [
      agent.bin,
      '-c',
      `mcp_servers.${SERVER_NAME}.command=${JSON.stringify(command)}`,
      '-c',
      `mcp_servers.${SERVER_NAME}.args=${JSON.stringify(args)}`,
      prompt ? `${input.persona}\n\n${prompt}` : input.persona,
    ];
    return { argv, files: [] };
  }
  const argv = [agent.bin, '--workspace', input.cwd];
  const text = prompt ? `${input.persona}\n\n${prompt}` : input.persona;
  argv.push(text);
  return { argv, files: [] };
}

export function cursorMcpPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

/** Merge the pf server into an MCP config, keeping every other server and key. */
export function withPulpfixerServer(current: Record<string, unknown>, serverArgv: string[]): Record<string, unknown> {
  const [command, ...args] = serverArgv;
  const servers = current.mcpServers && typeof current.mcpServers === 'object' ? (current.mcpServers as Record<string, unknown>) : {};
  return { ...current, mcpServers: { ...servers, [SERVER_NAME]: { command, args } } };
}

export function cursorMcpRegistered(file = cursorMcpPath()): boolean {
  const json = readJson<{ mcpServers?: Record<string, unknown> }>(file);
  return Boolean(json?.mcpServers && SERVER_NAME in json.mcpServers);
}

/** Add the pf server to a Cursor MCP config. No project cwd: Cursor starts it in the workspace. */
export function writeCursorMcp(file = cursorMcpPath()): boolean {
  try {
    const current = readJson<Record<string, unknown>>(file) ?? {};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(withPulpfixerServer(current, mcpServerArgv()), null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}
