/**
 * Counts the files `git status --porcelain=v1 -z --untracked-files=all` lists (pure: the command lives in
 * `identityView.ts`). Each entry is `XY path`; a rename or copy is followed by one more entry holding the
 * old path, which is not another changed file.
 */
export function countChangedFiles(porcelainZ: string): number {
	const entries = porcelainZ.split('\0');
	let count = 0;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) {
			continue;
		}
		count++;
		if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
			i++; // skip the old path
		}
	}
	return count;
}
