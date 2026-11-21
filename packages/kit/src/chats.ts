import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reads the most recent Cursor agent chat of a folder from the transcripts Cursor keeps at
 * `~/.cursor/projects/<folder-slug>/agent-transcripts/<id>/<id>.jsonl` (one JSON event per line,
 * `{ role, message: { content: [{ type: 'text', text }] } }`). Read only, never written.
 */

export interface Chat {
  /** Chat id (the transcript folder name). */
  id: string;
  /** What the user asked, in order, with Cursor's wrapper tags removed. */
  requests: string[];
  /** The text of the last assistant message that has any. */
  answer: string;
  /** Transcript modified time, epoch ms. */
  updatedAt: number;
}

/** A chat id is the transcript folder name: hex and dashes only, so it can never leave the transcripts folder. */
export const CHAT_ID = /^[0-9a-f-]{8,64}$/i;

/** Files up to this size are read whole; a bigger one is read as its head and its tail. */
const WHOLE_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

/** `/Users/me/my-repo` -> `Users-me-my-repo` (Cursor's project folder naming). */
export function projectSlug(folderPath: string, collapse = true): string {
  const trimmed = folderPath.replace(/^[\\/]+/, '');
  return trimmed.replace(collapse ? /[^A-Za-z0-9]+/g : /[^A-Za-z0-9]/g, '-').replace(/^-+|-+$/g, '');
}

/** The transcript folders that may hold a folder's chats (Cursor has used both slug spellings). */
export function transcriptDirs(folderPath: string, home: string = os.homedir()): string[] {
  const root = path.join(home, '.cursor', 'projects');
  const slugs = new Set([projectSlug(folderPath, true), projectSlug(folderPath, false)]);
  return [...slugs].map((slug) => path.join(root, slug, 'agent-transcripts'));
}

/** The request out of a user message: what is inside `<user_query>`, else the text without Cursor's wrapper tags. */
export function requestFromUserText(text: string): string {
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  const body = query ? query[1]! : text.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/gi, ' ');
  return body.replace(/\[Image\]/g, ' ').trim();
}

interface Part {
  type?: string;
  text?: string;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Part[])
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** Requests and last answer out of a transcript's text. A line that is not JSON (cut by the read limit) is skipped. */
export function parseTranscript(raw: string): { requests: string[]; answer: string } {
  const requests: string[] = [];
  let answer = '';
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let e: { role?: string; message?: unknown };
    try {
      e = JSON.parse(l) as typeof e;
    } catch {
      continue;
    }
    if (e.role === 'user') {
      const q = requestFromUserText(textOf(e.message));
      if (q) requests.push(q);
    } else if (e.role === 'assistant') {
      const t = textOf(e.message);
      if (t) answer = t;
    }
  }
  return { requests, answer };
}

function readTranscript(file: string, size: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const at = (start: number, length: number) => {
      const buf = Buffer.alloc(length);
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, length, start));
    };
    if (size <= WHOLE_BYTES) return at(0, size);
    const tail = at(size - TAIL_BYTES, TAIL_BYTES);
    // The tail starts mid-line: drop that partial line.
    return `${at(0, HEAD_BYTES)}\n${tail.slice(tail.indexOf('\n') + 1)}`;
  } finally {
    fs.closeSync(fd);
  }
}

/** Candidate transcript files for a folder: `<dir>/<id>/<id>.jsonl` or `<dir>/<id>.jsonl`. */
function transcriptFiles(folderPath: string, home: string): { id: string; file: string; mtime: number; size: number }[] {
  const found = new Map<string, { id: string; file: string; mtime: number; size: number }>();
  for (const dir of transcriptDirs(folderPath, home)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const id = entry.isDirectory() ? entry.name : entry.name.replace(/\.jsonl$/, '');
      if (!CHAT_ID.test(id)) continue;
      const file = entry.isDirectory() ? path.join(dir, id, `${id}.jsonl`) : entry.name.endsWith('.jsonl') ? path.join(dir, entry.name) : '';
      if (!file) continue;
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) found.set(file, { id, file, mtime: stat.mtimeMs, size: stat.size });
      } catch {
        // Not a transcript file.
      }
    }
  }
  return [...found.values()];
}

/**
 * The most recent chat of `folderPath` (or the one named by `opts.id`), or null when there is none, the id
 * is not a chat id, or the transcript cannot be read. Chats with no request at all are skipped.
 */
export function readLastChat(folderPath: string, opts: { home?: string; id?: string } = {}): Chat | null {
  const home = opts.home ?? os.homedir();
  if (opts.id !== undefined && !CHAT_ID.test(opts.id)) return null;
  const files = transcriptFiles(folderPath, home)
    .filter((f) => opts.id === undefined || f.id.toLowerCase() === opts.id.toLowerCase())
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    try {
      const { requests, answer } = parseTranscript(readTranscript(f.file, f.size));
      if (requests.length) return { id: f.id, requests, answer, updatedAt: f.mtime };
    } catch {
      // Unreadable transcript: try the next one.
    }
  }
  return null;
}
