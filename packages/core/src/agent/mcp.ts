import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ElicitResult, ToolSession } from '@pulpfixer/kit/agent-tool';
import { pfHome } from '@pulpfixer/kit/constants';
import type { Context } from '@pulpfixer/kit/context';
import { openAudit } from '../audit.js';
import { findSkill, loadAgentSkills, skillText, TOOLS, type Tool } from './tools.js';

/** Name agent CLIs show for the server; Claude Code tools become `mcp__pulpfixer__<tool>`. */
export const SERVER_NAME = 'pulpfixer';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

/** State of one MCP connection that tools can use: who the client is and how to reach the user. */
export interface ServerSession {
  id: string;
  /** Capabilities the client sent in `initialize`. */
  clientCapabilities: Record<string, unknown>;
  /** Approvals need an elicitation; the client's own tool prompt does not count (it was told to run approval tools unasked). */
  requireElicitation: boolean;
  /** Send a request to the client and wait for its answer. Missing outside `serve`. */
  request?(method: string, params: Record<string, unknown>): Promise<unknown>;
  audit(event: Record<string, unknown>): void;
}

const result = (id: JsonRpcRequest['id'], value: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result: value });
const error = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Form elicitation is offered as `elicitation: {}` (2025-06-18) or `elicitation: { form: {} }` (later revisions). */
export function canElicitForm(capabilities: Record<string, unknown>): boolean {
  const e = capabilities.elicitation;
  return isObj(e) && (Object.keys(e).length === 0 || isObj(e.form));
}

function parseElicit(value: unknown): ElicitResult {
  const v = isObj(value) ? value : {};
  const action = v.action === 'accept' || v.action === 'decline' ? v.action : 'cancel';
  return { action, ...(isObj(v.content) ? { content: v.content } : {}) };
}

function toolSession(s: ServerSession): ToolSession {
  const request = s.request;
  return {
    id: s.id,
    ...(request && canElicitForm(s.clientCapabilities)
      ? { elicit: async (message: string, requestedSchema: Record<string, unknown>) => parseElicit(await request('elicitation/create', { message, requestedSchema })) }
      : {}),
    trustClientPrompt: !s.requireElicitation,
    audit: (event) => s.audit(event),
  };
}

/** A session that only lives for one call (tests, or `handle` outside `serve`): no client requests, no audit file. */
export function detachedSession(): ServerSession {
  return { id: crypto.randomBytes(4).toString('hex'), clientCapabilities: {}, requireElicitation: true, audit: () => undefined };
}

/** Answer one JSON-RPC message. Notifications (no id) get null. `tools` defaults to the repo tools. */
export async function handle(ctx: Context, req: JsonRpcRequest, tools: Tool[] = TOOLS, session: ServerSession = detachedSession()): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined;
  const params = req.params ?? {};
  switch (req.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      if (isObj(params.capabilities)) session.clientCapabilities = params.capabilities;
      const host = tools.some((t) => t.name === 'pf_host_status');
      return result(req.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: SERVER_NAME, version: ctx.version },
        instructions: host
          ? 'pulpfixer (pf) tools for this host: status, security updates, packages, services, patching and allowlisted restarts. Start with pf_host_status.'
          : 'pulpfixer (pf) tools for this repo: resolved commands, runs, versions, staging deploys, skills and scoped read-only AWS access. Start with pf_commands.',
      });
    }
    case 'ping':
      return isNotification ? null : result(req.id, {});
    case 'tools/list':
      return result(req.id, { tools: tools.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly } })) });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = tools.find((t) => t.name === name);
      if (!tool) return error(req.id, -32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      try {
        const r = await tool.run(ctx, args, toolSession(session));
        session.audit({ event: 'tool', tool: name, args, ok: r.ok });
        return result(req.id, { content: [{ type: 'text', text: r.text }], isError: !r.ok });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        session.audit({ event: 'tool', tool: name, args, ok: false, error: message });
        return result(req.id, { content: [{ type: 'text', text: `pf ${name} failed: ${message}` }], isError: true });
      }
    }
    case 'prompts/list':
      return result(req.id, {
        prompts: loadAgentSkills(ctx).map((s) => ({
          name: s.name,
          description: s.description,
          arguments: [{ name: 'task', description: 'What to do with the skill', required: false }],
        })),
      });
    case 'prompts/get': {
      const name = typeof params.name === 'string' ? params.name : '';
      const skill = findSkill(ctx, name);
      if (!skill) return error(req.id, -32602, `Unknown prompt: ${name}`);
      const task = (params.arguments as Record<string, unknown> | undefined)?.task;
      const text = `${skillText(skill)}\n\nFollow the skill above.${typeof task === 'string' && task.trim() ? `\nTask: ${task.trim()}` : ''}`;
      return result(req.id, { description: skill.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
    }
    default:
      if (isNotification) return null;
      return error(req.id, -32601, `Method not found: ${req.method ?? ''}`);
  }
}

export function agentAuditDir(): string {
  return path.join(pfHome(), 'agent', 'audit');
}

export interface ServeOptions {
  /** See `ServerSession.requireElicitation`. */
  requireElicitation?: boolean;
  /** Where the session's audit log goes; null keeps none. Defaults to `agentAuditDir()`. */
  auditDir?: string | null;
}

/**
 * Serve MCP over stdio: one JSON-RPC message per line. stdout carries only protocol messages,
 * so nothing else in this process may write to it. Resolves when stdin closes.
 * Tools may also send requests to the client (elicitation); their answers come back on stdin.
 */
export function serve(
  ctx: Context,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  tools: Tool[] = TOOLS,
  opts: ServeOptions = {},
): Promise<number> {
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + '\n');
  const pending = new Set<Promise<void>>();
  const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const id = crypto.randomBytes(4).toString('hex');
  const auditDir = opts.auditDir === undefined ? agentAuditDir() : opts.auditDir;
  let audit: { fd: number } | null | undefined = auditDir ? undefined : null;
  const session: ServerSession = {
    id,
    clientCapabilities: {},
    requireElicitation: Boolean(opts.requireElicitation),
    request(method, params) {
      const rid = `pf-${nextId++}`;
      return new Promise((resolve, reject) => {
        waiting.set(rid, { resolve, reject });
        send({ jsonrpc: '2.0', id: rid, method, params });
      });
    },
    audit(event) {
      try {
        if (audit === undefined) {
          const header = { id, startedAt: new Date().toISOString(), kind: 'agent', cwd: ctx.cwd, user: os.userInfo().username, pf: ctx.version };
          audit = openAudit(auditDir!, header);
        }
        if (audit) fs.writeSync(audit.fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
      } catch {
        // auditing must never break a tool call
      }
    },
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcRequest & { result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      send(error(null, -32700, 'Parse error'));
      return;
    }
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const w = waiting.get(String(msg.id));
      if (w) {
        waiting.delete(String(msg.id));
        if (msg.error) w.reject(new Error(msg.error.message ?? 'request failed'));
        else w.resolve(msg.result);
      }
      return;
    }
    const req = msg;
    const p = handle(ctx, req, tools, session)
      .then((res) => {
        if (res) send(res);
      })
      .catch((e: unknown) => {
        if (req.id !== undefined) send(error(req.id, -32603, e instanceof Error ? e.message : String(e)));
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  });
  return new Promise((resolve) => {
    rl.on('close', () => {
      for (const w of waiting.values()) w.reject(new Error('the client disconnected'));
      waiting.clear();
      void Promise.allSettled([...pending]).then(() => {
        if (audit) fs.closeSync(audit.fd);
        resolve(0);
      });
    });
  });
}
