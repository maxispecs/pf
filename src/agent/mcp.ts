import readline from 'node:readline';
import type { Context } from '../context.js';
import { findSkill, findTool, loadAgentSkills, skillText, TOOLS } from './tools.js';

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

const result = (id: JsonRpcRequest['id'], value: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result: value });
const error = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Answer one JSON-RPC message. Notifications (no id) get null. */
export async function handle(ctx: Context, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined;
  const params = req.params ?? {};
  switch (req.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return result(req.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: SERVER_NAME, version: ctx.version },
        instructions: 'pulpfixer (pf) tools for this repo: resolved commands, runs, versions, staging deploys and skills. Start with pf_commands.',
      });
    }
    case 'ping':
      return isNotification ? null : result(req.id, {});
    case 'tools/list':
      return result(req.id, { tools: TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly } })) });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = findTool(name);
      if (!tool) return error(req.id, -32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      try {
        const r = await tool.run(ctx, args);
        return result(req.id, { content: [{ type: 'text', text: r.text }], isError: !r.ok });
      } catch (e) {
        return result(req.id, { content: [{ type: 'text', text: `pf ${name} failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
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

/**
 * Serve MCP over stdio: one JSON-RPC message per line. stdout carries only protocol messages,
 * so nothing else in this process may write to it. Resolves when stdin closes.
 */
export function serve(ctx: Context, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<number> {
  const send = (msg: JsonRpcResponse) => output.write(JSON.stringify(msg) + '\n');
  const pending = new Set<Promise<void>>();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      send(error(null, -32700, 'Parse error'));
      return;
    }
    const p = handle(ctx, req)
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
      void Promise.allSettled([...pending]).then(() => resolve(0));
    });
  });
}
