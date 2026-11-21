import { spawn } from 'node:child_process';
import type { AgentInfo } from './agents.js';

/**
 * Ask an agent CLI one question and get its plain text answer back: no pf persona, no MCP tools, and no
 * edit permission (print mode has no permission dialog, so a tool that needs one is refused). The caller
 * puts everything the agent needs into the prompt and falls back when this returns null.
 * Flags for claude and cursor-agent are checked against their `--help`; codex's `exec` is the documented
 * non-interactive form (read-only sandbox by default).
 */
export function oneshotArgv(agent: AgentInfo, prompt: string, cwd: string): string[] {
  if (agent.id === 'claude') return [agent.bin, '-p', '--output-format', 'text', prompt];
  if (agent.id === 'codex') return [agent.bin, 'exec', prompt];
  return [agent.bin, '-p', '--output-format', 'text', '--workspace', cwd, prompt];
}

/** The agent's stdout, or null when it could not start, failed, timed out or said nothing. stdin and stderr are not connected. */
export function agentText(agent: AgentInfo, prompt: string, cwd: string, timeoutMs = 90_000): Promise<string | null> {
  const argv = oneshotArgv(agent, prompt, cwd);
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v && v.trim() ? v : null);
    };
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'ignore'], env });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(null);
    }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > 200_000) child.kill('SIGTERM');
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out : null));
  });
}
