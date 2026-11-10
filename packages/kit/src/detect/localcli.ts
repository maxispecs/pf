import fs from 'node:fs';
import path from 'node:path';
import { exists, listDir, readText } from '../util.js';

/**
 * A repo's own developer CLI: an executable `a` (or `cli/run`) at the root that runs scripts under
 * `cli/commands/` (`deploy/staging.sh` is `deploy:staging`). Scripts describe themselves with
 * `# desc:` and `# usage:` header comments.
 */
export interface LocalCliCommand {
  /** `deploy:staging` */
  name: string;
  /** Path relative to the repo root. */
  file: string;
  desc: string;
  usage: string[];
  /** The script takes `-y` / `--yes` to skip its own confirmation. */
  acceptsYes: boolean;
  /** The usage mentions a message (`./a deploy:staging [message]`), so `pf d "text"` can pass one. */
  acceptsMessage: boolean;
}

export interface LocalCli {
  /** What to run from the repo root, e.g. `./a`. */
  entry: string;
  commands: LocalCliCommand[];
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const f of listDir(dir).sort()) {
    const full = path.join(dir, f);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(full, `${prefix}${f}/`));
    else if (f.endsWith('.sh')) out.push(`${prefix}${f}`);
  }
  return out;
}

const header = (text: string, key: string): string[] =>
  text.split('\n').flatMap((line) => {
    const m = new RegExp(`^#\\s*${key}:\\s*(.*)$`).exec(line);
    return m ? [m[1]!.trim()] : [];
  });

/** The repo's `./a` style CLI, or null when it has none. */
export function detectLocalCli(root: string): LocalCli | null {
  const entry = exists(root, 'a') && exists(root, 'cli', 'run') ? './a' : exists(root, 'cli', 'run') ? './cli/run' : null;
  if (!entry) return null;
  const base = path.join(root, 'cli', 'commands');
  const commands = walk(base).map((rel): LocalCliCommand => {
    const text = readText(base, rel) ?? '';
    const usage = header(text, 'usage');
    return {
      name: rel.replace(/\.sh$/, '').split('/').join(':'),
      file: path.posix.join('cli', 'commands', rel),
      desc: header(text, 'desc')[0] ?? '',
      usage,
      acceptsYes: usage.some((u) => /(^|\s)(-y|--yes)\b/.test(u)),
      acceptsMessage: usage.some((u) => /\b(message|msg)\b/i.test(u)),
    };
  });
  return commands.length ? { entry, commands } : null;
}

/** Names of local CLI commands that map to a pf task, best match first. */
export const LOCAL_CLI_TASKS = {
  dev: ['dev', 'serve', 'start'],
  build: ['build'],
  test: ['test'],
  lint: ['lint'],
  install: ['install', 'setup', 'bootstrap'],
} as const;
