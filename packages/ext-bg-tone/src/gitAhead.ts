/**
 * Counts the commits `git rev-list` printed (pure: the command lives in `identityView.ts`). One 40 or 64
 * digit hash per line; anything else is ignored.
 */
export function parseAheadCount(revList: string): number {
	return revList.split('\n').filter(line => /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(line.trim())).length;
}
