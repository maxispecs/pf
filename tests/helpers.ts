import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a temp directory with the given files (path -> content). */
export function mkRepo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

export const json = (o: unknown): string => JSON.stringify(o, null, 2);

/** `argv` of a candidate list as printable strings. */
export function lines(list: { cmd: { argv: string[]; shell?: boolean } }[]): string[] {
  return list.map((c) => c.cmd.argv.join(' '));
}
