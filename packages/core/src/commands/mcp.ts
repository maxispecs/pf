import fs from 'node:fs';
import path from 'node:path';
import { serve } from '../agent/mcp.js';
import { buildContext } from '@pulpfixer/kit/context';
import { loadHostConfig } from '../host/config.js';
import { hostTools } from '../host/tools.js';
import type { Command } from '@pulpfixer/kit/types';

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
  usage: 'pf mcp [--cwd <dir>] [--host [--apply]]',
  hidden: true,
  async run(ctx, args) {
    // `pf host fix` serves the host tools; write tools change the host only when it passed --apply.
    if (args.includes('--host')) return serve(ctx, process.stdin, process.stdout, hostTools({ config: loadHostConfig(), apply: args.includes('--apply') }));
    const dir = mcpWorkdir(args, ctx.cwd);
    return serve(dir === ctx.cwd ? ctx : buildContext(dir));
  },
};
