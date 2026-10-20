import fs from 'node:fs';
import path from 'node:path';
import { serve } from '../agent/mcp.js';
import { buildContext } from '../context.js';
import type { Command } from './types.js';

/** `--cwd <dir>`, ignoring placeholders the launching agent did not expand (e.g. `${workspaceFolder}`). */
export function mcpWorkdir(args: string[], fallback: string): string {
  const i = args.findIndex((a) => a === '--cwd' || a.startsWith('--cwd='));
  if (i === -1) return fallback;
  const value = args[i]!.startsWith('--cwd=') ? args[i]!.slice('--cwd='.length) : args[i + 1];
  if (!value || value.includes('${')) return fallback;
  const dir = path.resolve(value);
  return fs.existsSync(dir) ? dir : fallback;
}

export const mcpCommand: Command = {
  name: 'mcp',
  summary: 'Serve pf tools and skills to an agent CLI over MCP (stdio)',
  group: 'Agent',
  usage: 'pf mcp [--cwd <dir>]',
  hidden: true,
  async run(ctx, args) {
    const dir = mcpWorkdir(args, ctx.cwd);
    return serve(dir === ctx.cwd ? ctx : buildContext(dir));
  },
};
