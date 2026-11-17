/** The repo's version file, written by the `ver` CLI (`pnpm ver`, `pf ver`). */
export const VERSIONS_FILE = 'versions.json';

/**
 * The stack (whole repo) version out of a `versions.json` text, as shown beside the repo name. `undefined`
 * when the text is missing, not JSON, or has no plain `major.minor` style version (nothing is guessed).
 */
export function parseStackVersion(text: string | null): string | undefined {
	if (text === null) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const stack = (parsed as { stack?: unknown }).stack;
	const version = stack && typeof stack === 'object' ? (stack as { version?: unknown }).version : undefined;
	return typeof version === 'string' && /^\d+(\.\d+){0,2}$/.test(version.trim()) ? version.trim() : undefined;
}
