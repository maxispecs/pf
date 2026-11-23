/**
 * Parses the recent-commits listing for the Source Control card (pure: the git call lives in `identityView.ts`).
 * The format is `git log --format=%H%x1f%ct%x1f%s -n <n>`: one commit per line, fields split by the unit separator.
 */

export interface RecentCommit {
	/** Full hash (the card shows the first 7 characters). */
	hash: string;
	/** First line of the message. */
	title: string;
	/** Commit time, epoch ms. */
	updatedAt: number;
	/** True when a remote has the commit, false when it is only local; absent when that is unknown (no git answer). */
	pushed?: boolean;
}

export const LOG_ARGS_FORMAT = '--format=%H%x1f%ct%x1f%s';

const MAX_TITLE = 80;

/** The hashes in a `git rev-list` output (one per line); lines that are not a hash are skipped. */
export function parseHashSet(output: string): Set<string> {
	const hashes = new Set<string>();
	for (const line of output.split('\n')) {
		const hash = line.trim().toLowerCase();
		if (/^[0-9a-f]{4,64}$/.test(hash)) {
			hashes.add(hash);
		}
	}
	return hashes;
}

/**
 * `unpushed` is the set of local-only commits (`git rev-list @{upstream}..HEAD`, or `HEAD --not --remotes` without an
 * upstream); with it each commit gets `pushed`, without it the field is left out.
 */
export function parseRecentCommits(output: string, limit = 3, unpushed?: Set<string>): RecentCommit[] {
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
		const commit: RecentCommit = { hash, title: title || '(no message)', updatedAt: time * 1000 };
		if (unpushed) {
			commit.pushed = !unpushed.has(hash.toLowerCase());
		}
		commits.push(commit);
		if (commits.length >= limit) {
			break;
		}
	}
	return commits;
}
