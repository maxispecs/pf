/**
 * The repo side of the settings: the `bgTone` section of the repo's `pulpfixer.json`, so the tone and
 * the logo are committed with the repo. Pure text in, text out; `store.ts` does the file and VS Code work.
 */

/** The repo config file pf writes. */
export const CONFIG_FILE = 'pulpfixer.json';
/** The name older pf versions wrote. Still read (and written) while no pulpfixer.json exists. */
export const LEGACY_CONFIG_FILE = 'pf.json';
/** Key of the section this extension owns. */
export const SECTION = 'bgTone';

/** Which file to use: pulpfixer.json, else a legacy pf.json that was not converted yet, else pulpfixer.json (to create). */
export function pickConfigFile(exists: (name: string) => boolean): string {
	return !exists(CONFIG_FILE) && exists(LEGACY_CONFIG_FILE) ? LEGACY_CONFIG_FILE : CONFIG_FILE;
}

/**
 * Whether a config file's text means the repo is set up for pf (`pf rp` creates pulpfixer.json). Any
 * non-empty file counts, even one with no `bgTone` section or one that is not valid JSON.
 */
export function isPfRepoConfig(text: string | null): boolean {
	return text !== null && text.trim() !== '';
}

/**
 * Whether the Repo Identity card (and its `when` context keys) should exist. It shows once there is
 * something to show (a logo or a tone color) and also in a repo set up for pf, where the card is useful
 * with just the repo name and its action buttons.
 */
export function identityVisible(o: { hasFolder: boolean; hasLogo: boolean; hasColor: boolean; pfRepo: boolean }): boolean {
	return o.hasFolder && (o.hasLogo || o.hasColor || o.pfRepo);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export type ParsedSection =
	/** The file is missing or empty, or has no `bgTone` object. */
	| { type: 'none' }
	| { type: 'section'; values: Record<string, unknown> }
	/** The file is not a JSON object (or `bgTone` is not an object): it is never overwritten. */
	| { type: 'invalid'; reason: string };

/** Reads the `bgTone` section out of a config file's text (null: the file does not exist). */
export function parseSection(text: string | null): ParsedSection {
	if (text === null || text.trim() === '') {
		return { type: 'none' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { type: 'invalid', reason: `not valid JSON (${e instanceof Error ? e.message : String(e)})` };
	}
	if (!isObject(parsed)) {
		return { type: 'invalid', reason: 'not a JSON object' };
	}
	const section = parsed[SECTION];
	if (section === undefined) {
		return { type: 'none' };
	}
	return isObject(section) ? { type: 'section', values: section } : { type: 'invalid', reason: `"${SECTION}" is not an object` };
}

export type EditResult = { ok: true; text: string } | { ok: false; reason: string };

/** Indentation of the file (two spaces when it cannot tell), so an edit does not reformat it. */
function indentOf(text: string): string | number {
	return /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
}

/**
 * Sets keys of the `bgTone` section (`undefined` removes a key; an empty section is removed). Every other
 * key, the indentation and the trailing newline are kept. Text that is not a JSON object is refused.
 */
export function editSection(text: string | null, changes: Record<string, unknown>): EditResult {
	const current = parseSection(text);
	if (current.type === 'invalid') {
		return { ok: false, reason: current.reason };
	}
	const root: Record<string, unknown> = text && text.trim() !== '' ? (JSON.parse(text) as Record<string, unknown>) : {};
	const values: Record<string, unknown> = current.type === 'section' ? { ...current.values } : {};
	for (const [key, value] of Object.entries(changes)) {
		if (key === '__proto__') {
			continue;
		}
		if (value === undefined) {
			delete values[key];
		} else {
			values[key] = value;
		}
	}
	if (Object.keys(values).length > 0) {
		root[SECTION] = values;
	} else {
		delete root[SECTION];
	}
	if (text === null && Object.keys(root).length === 0) {
		return { ok: true, text: '' };
	}
	const trailingNewline = text === null || text.trim() === '' || text.endsWith('\n');
	return { ok: true, text: JSON.stringify(root, null, text ? indentOf(text) : 2) + (trailingNewline ? '\n' : '') };
}
