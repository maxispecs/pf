import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Reads the most recent Cursor agent chat for a folder from the transcripts Cursor keeps at
 * `~/.cursor/projects/<folder-slug>/agent-transcripts/<id>/<id>.jsonl`.
 * Deliberately free of `vscode` imports so it can be unit tested.
 */

export type AgentStatus = 'running' | 'success' | 'error' | 'stopped';

export interface AgentRun {
	/** Chat id (the transcript folder name); also the key of the chat in Cursor's state database. */
	id: string;
	/** First user request of the chat, whitespace collapsed and truncated. Used until the real tab title is known. */
	title: string;
	status: AgentStatus;
	/** Last activity (transcript modified time), epoch ms. */
	updatedAt: number;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 8 * 1024;
const MAX_TITLE = 80;
/** A transcript with no final `turn_ended` marker is "running" only while it is still being written. */
const RUNNING_WINDOW_MS = 2 * 60 * 1000;

/** `/Users/me/my-repo` -> `Users-me-my-repo` (Cursor's project folder naming). */
export function projectSlug(folderPath: string, collapse = true): string {
	const trimmed = folderPath.replace(/^[\\/]+/, '');
	return trimmed.replace(collapse ? /[^A-Za-z0-9]+/g : /[^A-Za-z0-9]/g, '-').replace(/^-+|-+$/g, '');
}

function transcriptDirs(folderPath: string, home: string): string[] {
	const root = path.join(home, '.cursor', 'projects');
	const slugs = new Set([projectSlug(folderPath, true), projectSlug(folderPath, false)]);
	return [...slugs].map(slug => path.join(root, slug, 'agent-transcripts'));
}

/** Collapses whitespace and truncates to the title length. */
export function cleanTitle(text: string): string {
	let out = text.replace(/\s+/g, ' ').trim();
	if (out.length > MAX_TITLE) {
		out = out.slice(0, MAX_TITLE - 1).trimEnd() + '\u2026';
	}
	return out;
}

/** Pulls the request text out of a user message, dropping Cursor's attachment/wrapper tags. */
export function titleFromUserText(text: string): string {
	const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
	return cleanTitle(
		(query ? query[1] : text)
			.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')
			.replace(/\[Image\]/g, ' '),
	);
}

const CHAT_ID = /^[0-9a-f-]{8,64}$/i;

/** Parses `id<TAB>name` lines from the sqlite3 CLI into a map, skipping chats without a name. */
export function parseTitleRows(output: string): Map<string, string> {
	const titles = new Map<string, string>();
	for (const line of output.split('\n')) {
		const tab = line.indexOf('\t');
		if (tab <= 0) {
			continue;
		}
		const id = line.slice(0, tab);
		const name = cleanTitle(line.slice(tab + 1));
		if (CHAT_ID.test(id) && name) {
			titles.set(id, name);
		}
	}
	return titles;
}

/**
 * Looks up the chat tab titles Cursor shows ("composerData:<id>".name in its global state database)
 * with the system `sqlite3` CLI, read-only. Resolves to an empty map when anything is unavailable,
 * so callers can fall back to the first request.
 */
export function readChatTitles(dbPath: string, ids: string[]): Promise<Map<string, string>> {
	const safeIds = ids.filter(id => CHAT_ID.test(id));
	if (safeIds.length === 0 || !fs.existsSync(dbPath)) {
		return Promise.resolve(new Map());
	}
	const keys = safeIds.map(id => `'composerData:${id}'`).join(',');
	const sql =
		`select substr(key, 14), replace(replace(json_extract(value, '$.name'), char(10), ' '), char(9), ' ') ` +
		`from cursorDiskKV where key in (${keys});`;
	const bin = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
	return new Promise(resolve => {
		execFile(
			bin,
			['-readonly', '-separator', '\t', dbPath, sql],
			{ timeout: 3000, maxBuffer: 1024 * 1024 },
			(err, stdout) => resolve(err ? new Map() : parseTitleRows(String(stdout))),
		);
	});
}

/** Title from the first line of a transcript (the first user message). */
export function titleFromHead(head: string): string {
	const firstLine = head.split('\n', 1)[0] ?? '';
	try {
		const parsed = JSON.parse(firstLine) as { message?: { content?: Array<{ type?: string; text?: string }> } };
		const text = (parsed.message?.content ?? [])
			.filter(part => part?.type === 'text' && typeof part.text === 'string')
			.map(part => part.text)
			.join('\n');
		return titleFromUserText(text);
	} catch {
		// The first line was cut off by the read limit: recover the query from the raw JSON text.
		return titleFromUserText(firstLine.replace(/\\n/g, '\n').replace(/\\"/g, '"'));
	}
}

/** Status from the last transcript line and how fresh the file is. */
export function statusFromTail(tail: string, updatedAt: number, now: number): AgentStatus {
	const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
	const last = lines[lines.length - 1];
	if (last) {
		try {
			const parsed = JSON.parse(last) as { type?: string; status?: string };
			if (parsed.type === 'turn_ended') {
				return parsed.status === 'success' ? 'success' : parsed.status === 'error' ? 'error' : 'stopped';
			}
		} catch {
			// Partial/huge last line: fall through to the freshness check.
		}
	}
	return now - updatedAt <= RUNNING_WINDOW_MS ? 'running' : 'stopped';
}

function readRange(file: string, start: number, length: number): string {
	const fd = fs.openSync(file, 'r');
	try {
		const buf = Buffer.alloc(length);
		const read = fs.readSync(fd, buf, 0, length, start);
		return buf.toString('utf8', 0, read);
	} finally {
		fs.closeSync(fd);
	}
}

/** The `limit` most recently active agent chats for `folderPath`, newest first (empty when none, or remote). */
export function readRecentAgentRuns(
	folderPath: string,
	opts: { home?: string; now?: number; limit?: number } = {},
): AgentRun[] {
	const home = opts.home ?? os.homedir();
	const now = opts.now ?? Date.now();
	const limit = opts.limit ?? 3;

	const found = new Map<string, { file: string; mtime: number; size: number }>();
	for (const dir of transcriptDirs(folderPath, home)) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const candidates = entry.isDirectory()
				? [path.join(dir, entry.name, `${entry.name}.jsonl`)]
				: entry.name.endsWith('.jsonl')
					? [path.join(dir, entry.name)]
					: [];
			for (const file of candidates) {
				try {
					const stat = fs.statSync(file);
					found.set(file, { file, mtime: stat.mtimeMs, size: stat.size });
				} catch {
					// Not a transcript file.
				}
			}
		}
	}

	const runs: AgentRun[] = [];
	const newest = [...found.values()].sort((a, b) => b.mtime - a.mtime);
	for (const entry of newest) {
		if (runs.length >= limit) {
			break;
		}
		try {
			const head = readRange(entry.file, 0, Math.min(entry.size, HEAD_BYTES));
			const tailStart = Math.max(0, entry.size - TAIL_BYTES);
			const tail = readRange(entry.file, tailStart, entry.size - tailStart);
			runs.push({
				id: path.basename(entry.file, '.jsonl'),
				title: titleFromHead(head) || 'Untitled chat',
				status: statusFromTail(tail, entry.mtime, now),
				updatedAt: entry.mtime,
			});
		} catch {
			// Unreadable transcript: skip it.
		}
	}
	return runs;
}
