// The small convention every tool shares (permanent or one-off):
//   - the tool's name is its folder name; its files live in files/<name>/{in,out,logs}
//   - it SIMULATES unless you pass --live: reads run, writes are only logged
//   - everything it logs is also written to files/<name>/logs/. Logs are NEVER deleted: older ones are moved
//     (not copied, not compressed) to files/<name>/logs/archive/YYYY-MM/ so the newest 20 stay easy to find
// A tool is a folder with an index.mjs that calls runTool(import.meta.url, async (ctx) => { ... }).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { fileDirs } from './paths.mjs';

const KEEP_RECENT = 20; // logs left in logs/; older ones are moved to logs/archive/<month>/

/** `--live --connection=x file.json` -> { live: true, flags: { live: true, connection: 'x' }, args: ['file.json'] } */
export function parseArgs(argv) {
  const flags = {};
  const args = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      flags[eq === -1 ? a.slice(2) : a.slice(2, eq)] = eq === -1 ? true : a.slice(eq + 1);
    } else args.push(a);
  }
  return { flags, args };
}

/**
 * Keep the newest logs in `logsDir` and MOVE the rest to `archive/<YYYY-MM>/`. Nothing is deleted or
 * overwritten: a file whose archive name is taken stays where it is. Never throws (a tool must still run).
 * Returns how many were archived.
 */
export function archiveOldLogs(logsDir, keep = KEEP_RECENT - 1) {
  let moved = 0;
  try {
    const logs = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')).sort();
    for (const f of logs.slice(0, Math.max(0, logs.length - keep))) {
      const month = /^\d{4}-\d{2}/.exec(f)?.[0] ?? 'undated';
      const dest = path.join(logsDir, 'archive', month);
      const target = path.join(dest, f);
      if (fs.existsSync(target)) continue; // never overwrite an archived log
      fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(path.join(logsDir, f), target);
      moved++;
    }
  } catch {
    // archiving is housekeeping: leave the logs where they are
  }
  return moved;
}

export async function runTool(metaUrl, main, argv = process.argv.slice(2)) {
  const name = path.basename(path.dirname(fileURLToPath(metaUrl)));
  const { flags, args } = parseArgs(argv);
  const live = flags.live === true;
  const dirs = fileDirs(name);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(dirs.logs, `${stamp}.log`);
  archiveOldLogs(dirs.logs);

  const log = (...parts) => {
    const line = parts.join(' ');
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };

  const ctx = {
    name,
    live,
    flags,
    args,
    dirs,
    log,
    /** A DynamoDB connection: simulated writes unless --live. Only the statement text is logged, never values. */
    openDb: (opts = {}) =>
      openDb({
        writes: live ? 'allow' : 'dry',
        onDryWrite: (q) => log(`[simulated] ${q.text}`),
        ...(typeof flags.connection === 'string' ? { connection: flags.connection } : {}),
        ...opts,
      }),
  };

  log(`${name}: ${live ? 'LIVE: writes are real' : 'simulation: writes are only logged (add --live to apply them)'}`);
  try {
    await main(ctx);
  } catch (e) {
    log(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
