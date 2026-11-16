import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_NAME } from '../agent/mcp.js';
import type { HostConfig } from './config.js';
import type { Identity } from './aws.js';
import { hostTools } from './tools.js';

/** System prompt for `pf host fix`. */
export function hostPersona(opts: { apply: boolean; identity: Identity | null }): string {
  const where = opts.identity ? `EC2 instance ${opts.identity.instanceId} in ${opts.identity.region}` : 'a server';
  return [
    `You are pulpfixer (pf) running on ${where}, invoked by an operator to fix a problem such as a pending security patch.`,
    'You can only act through the pulpfixer host tools. You have no shell and no file access.',
    '',
    'Rules:',
    '- Start with pf_host_status, then gather what the task needs (pf_host_security_updates, pf_host_package, pf_host_service).',
    opts.apply
      ? '- This run has --apply: you may call pf_host_patch and pf_host_restart when the task needs them. Change only what the task asks for.'
      : '- This run is plan-only: nothing may change. pf_host_patch and pf_host_restart only report what they would do.',
    '- Never reboot. If a reboot is pending, say so for the operator.',
    '- Never repeat secrets, tokens or credentials that show up in logs.',
    '- End with a short report: what you found, what you changed (or would change), and anything an operator must do.',
  ].join('\n');
}

export interface HostLaunchInput {
  config: HostConfig;
  task: string;
  apply: boolean;
  identity: Identity | null;
  mcpConfigPath: string;
  /** argv of `pf mcp --host`. Defaults to this process. */
  serverArgv?: string[];
}

export function hostServerArgv(apply: boolean): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? '', 'mcp', '--host', ...(apply ? ['--apply'] : [])];
}

/**
 * Headless Claude Code with no built-in tools (`--tools ""`), only the pf MCP server
 * (`--strict-mcp-config`), and `dontAsk`, which refuses any tool not listed in --allowedTools.
 * Plan-only runs list only the read-only tools; the server also refuses writes without --apply.
 */
export function buildHostLaunch(input: HostLaunchInput): { argv: string[]; mcpJson: string } {
  const [command, ...args] = input.serverArgv ?? hostServerArgv(input.apply);
  const allowed = hostTools({ config: input.config, apply: input.apply })
    .filter((t) => input.apply || t.readOnly)
    .map((t) => `mcp__${SERVER_NAME}__${t.name}`);
  const argv = [
    'claude',
    '-p',
    '--mcp-config', input.mcpConfigPath,
    '--strict-mcp-config',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--allowedTools', allowed.join(','),
    '--append-system-prompt', hostPersona({ apply: input.apply, identity: input.identity }),
    '--max-budget-usd', String(input.config.maxBudgetUsd),
    '--no-session-persistence',
    ...(input.config.model ? ['--model', input.config.model] : []),
    // `--allowedTools` is variadic, so the task stays after those single-value options.
    input.task,
  ];
  return { argv, mcpJson: JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }, null, 2) + '\n' };
}

export interface AuditHeader {
  id: string;
  startedAt: string;
  instanceId?: string;
  user: string;
  pf: string;
  mode: 'plan' | 'apply';
  task: string;
}

export function newAuditHeader(opts: { task: string; apply: boolean; identity: Identity | null; version: string }): AuditHeader {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    startedAt: new Date().toISOString(),
    ...(opts.identity ? { instanceId: opts.identity.instanceId } : {}),
    user: process.env.SUDO_USER ?? os.userInfo().username,
    pf: opts.version,
    mode: opts.apply ? 'apply' : 'plan',
    task: opts.task,
  };
}

export { openAudit } from '../audit.js';

/** Run the agent, copying its output to the terminal and the audit log. Resolves with the exit code. */
export function runAudited(argv: string[], env: NodeJS.ProcessEnv, audit: { fd: number } | null): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env });
    const copy = (to: NodeJS.WriteStream) => (chunk: Buffer) => {
      to.write(chunk);
      if (audit) fs.writeSync(audit.fd, chunk);
    };
    child.stdout.on('data', copy(process.stdout));
    child.stderr.on('data', copy(process.stderr));
    child.on('error', (e: NodeJS.ErrnoException) => {
      process.stderr.write(`${e.code === 'ENOENT' ? `${argv[0]} not found on PATH` : e.message}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      const exit = code ?? (signal ? 130 : 1);
      if (audit) {
        fs.writeSync(audit.fd, `\n${JSON.stringify({ finishedAt: new Date().toISOString(), exit })}\n`);
        fs.closeSync(audit.fd);
      }
      resolve(exit);
    });
  });
}
