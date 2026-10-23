import path from 'node:path';
import type { Context } from '../context.js';
import { formatCmd, shellCmd } from '../exec.js';
import type { Candidate, Task } from './stacks.js';

/**
 * Candidate commands for a task, best first:
 *   1. pf.json `commands.<task>`
 *   2. scripts or targets the repo already defines (package.json, composer.json, Makefile, justfile)
 *   3. conventional stack defaults
 */
export function candidates(task: Task, ctx: Context): Candidate[] {
  const list: Candidate[] = [];
  const override = ctx.config.commands[task];
  if (override && ctx.repo) {
    list.push({ cmd: shellCmd(override.run, path.resolve(ctx.repo.root, override.cwd ?? '.')), source: 'pf.json' });
  }
  for (const s of ctx.stacks) list.push(...(s.scripts[task] ?? []));
  for (const s of ctx.stacks) list.push(...(s.defaults[task] ?? []));
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = formatCmd(c.cmd);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
