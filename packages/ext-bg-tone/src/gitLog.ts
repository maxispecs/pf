/**
 * Parses the recent-commits listing for the Source Control card (pure: the git call lives in `identityView.ts`).
 * The format is `git log --format=%h%x1f%ct%x1f%s -n <n>`: one commit per line, fields split by the unit separator.
 */

export interface RecentCommit {
	/** Abbreviated hash. */
	hash: string;
	/** First line of the message. */
	title: string;
	/** Commit time, epoch ms. */
	updatedAt: number;
}

export const LOG_ARGS_FORMAT = '--format=%h%x1f%ct%x1f%s';

const MAX_TITLE = 80;

export function parseRecentCommits(output: string, limit = 3): RecentCommit[] {
	const commits: RecentCommit[] = [];
	for (const line of output.split('\n')) {
		const [hash, seconds, ...rest] = line.split('\x1f');
		const time = Number(seconds);
		if (!hash || !/^[0-9a-f]{4,64}$/i.test(hash) || !Number.isFinite(time)) {
			continue;
		}
		let title = rest.join('\x1f').replace(/\s+/g, ' ').trim();
		if (title.length > MAX_TITLE) {
			title = title.slice(0, MAX_TITLE - 1).trimEnd() + '\u2026';
		}
		commits.push({ hash, title: title || '(no message)', updatedAt: time * 1000 });
		if (commits.length >= limit) {
			break;
		}
	}
	return commits;
}
