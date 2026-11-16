import fs from 'node:fs';
import path from 'node:path';

/** Open a run's log in the audit dir (owner-only), starting with its header. Null when it cannot be written. */
export function openAudit(dir: string, header: { id: string; startedAt: string }): { file: string; fd: number } | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${header.startedAt.replace(/[:.]/g, '-')}-${header.id}.log`);
    const fd = fs.openSync(file, 'a', 0o600);
    fs.writeSync(fd, JSON.stringify(header) + '\n');
    return { file, fd };
  } catch {
    return null;
  }
}
