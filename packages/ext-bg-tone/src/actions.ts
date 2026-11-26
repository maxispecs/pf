/**
 * Repo actions for the identity card's buttons: what `pf actions --json` prints, validated, and the
 * terminal command line that runs one. Pure (no VS Code); `actionsService.ts` runs pf and the terminal.
 */

/** The `pf actions --json` shape this extension understands (`schema` in the document). */
export const SUPPORTED_SCHEMA = 1;
/** Codicon used when pf sends a name that is not one. */
export const FALLBACK_ICON = 'terminal';

export interface RepoAction {
	/** Stable id (`dev`, `deploy:staging`, a custom command's name). */
	id: string;
	/** Tooltip text. */
	label: string;
	/** Codicon name. */
	icon: string;
	featured: boolean;
	/** Conditions that must all hold for the button to show (`changes`, `unpushed`, `pfBehind`); empty: always. */
	when: string[];
	/** The pf arguments that run it. */
	argv: string[];
}

/** The pf that printed the list: its version and the stack version it was built from (null: no stamp, an older pf). */
export interface PfInfo {
	version: string;
	stack: string | null;
}

export type ParsedActions =
	| { ok: true; repo: string | null; pf: PfInfo | null; actions: RepoAction[] }
	| { ok: false; reason: string };

/** What a `when` condition is checked against. `null` / `undefined` means "could not be read". */
export interface ActionFacts {
	/** Files with uncommitted changes. */
	changes: number | null;
	/** Local commits no remote has. */
	unpushed: number | null;
	/** The repo's stack version (`versions.json`); empty when it has none. */
	repoStack: string;
	/** The pf's build stack: a version, null for a pf without a stamp, undefined when no pf answered. */
	pfStack: string | null | undefined;
}

/** `major.minor[.patch]` as numbers, or undefined when it is not one. */
function stackParts(v: string): number[] | undefined {
	return /^\d+(\.\d+){0,2}$/.test(v) ? v.split('.').map(Number) : undefined;
}

/** Negative, zero or positive like a sort comparator; undefined when either side is not a version. */
export function compareStack(a: string, b: string): number | undefined {
	const x = stackParts(a);
	const y = stackParts(b);
	if (!x || !y) {
		return undefined;
	}
	for (let i = 0; i < 3; i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	return 0;
}

/**
 * Whether one condition holds. A fact that could not be read, or a condition this version does not know,
 * counts as holding: a button is never hidden on a guess. A pf with no stack stamp is older than the stamp, so it is behind.
 */
export function conditionHolds(condition: string, facts: ActionFacts): boolean {
	switch (condition) {
		case 'changes':
			return facts.changes === null || facts.changes > 0;
		case 'unpushed':
			return facts.unpushed === null || facts.unpushed > 0;
		case 'pfBehind': {
			if (facts.pfStack === undefined || facts.repoStack === '') {
				return true; // no pf answered, or the repo has no stack version: nothing to compare
			}
			if (facts.pfStack === null) {
				return true; // a pf with no stamp predates it, so it is behind
			}
			const c = compareStack(facts.pfStack, facts.repoStack);
			return c === undefined || c < 0;
		}
		default:
			return true;
	}
}

/** True when every condition holds (no conditions: always). */
export function evaluateWhen(when: readonly string[], facts: ActionFacts): boolean {
	return when.every(c => conditionHolds(c, facts));
}

const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_TEXT = 120;
const MAX_ARGS = 8;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanText(v: unknown): string | undefined {
	if (typeof v !== 'string' || CONTROL.test(v)) {
		return undefined;
	}
	const text = v.trim();
	return text === '' ? undefined : text.slice(0, MAX_TEXT);
}

/** One action out of the JSON, or undefined when it is unusable (a bad one never hides the others). */
export function parseAction(raw: unknown): RepoAction | undefined {
	if (!isObject(raw)) {
		return undefined;
	}
	const id = cleanText(raw.id);
	const argv = raw.argv;
	if (!id || !Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS) {
		return undefined;
	}
	const args = argv.map(cleanText);
	if (args.some(a => a === undefined)) {
		return undefined;
	}
	const icon = typeof raw.icon === 'string' && ICON_NAME.test(raw.icon) ? raw.icon : FALLBACK_ICON;
	return {
		id,
		label: cleanText(raw.label) ?? id,
		icon,
		featured: raw.featured === true,
		when: Array.isArray(raw.when) ? raw.when.map(cleanText).filter((c): c is string => c !== undefined) : [],
		argv: args as string[],
	};
}

/** Parses the stdout of `pf actions [--all] --json`. */
export function parseActions(stdout: string): ParsedActions {
	// pf prints one JSON line on stdout; tolerate anything a wrapper script prints before it.
	const start = stdout.indexOf('{');
	if (start === -1) {
		return { ok: false, reason: 'pf printed no JSON (is pf up to date?)' };
	}
	let doc: unknown;
	try {
		doc = JSON.parse(stdout.slice(start).trim());
	} catch {
		return { ok: false, reason: 'pf printed JSON the extension cannot read' };
	}
	if (!isObject(doc) || !Array.isArray(doc.actions)) {
		return { ok: false, reason: 'pf printed an unexpected document' };
	}
	if (doc.schema !== SUPPORTED_SCHEMA) {
		return { ok: false, reason: `pf actions schema ${String(doc.schema)} is not supported (update the Background Tone extension and pf)` };
	}
	const seen = new Set<string>();
	const actions: RepoAction[] = [];
	for (const raw of doc.actions) {
		const action = parseAction(raw);
		if (action && !seen.has(action.id)) {
			seen.add(action.id);
			actions.push(action);
		}
	}
	return { ok: true, repo: typeof doc.repo === 'string' ? doc.repo : null, pf: parsePfInfo(doc.pf), actions };
}

/** The `pf` block of the document; null when an older pf did not print one. A missing stack stays null (no stamp). */
export function parsePfInfo(raw: unknown): PfInfo | null {
	if (!isObject(raw)) {
		return null;
	}
	const version = cleanText(raw.version) ?? '';
	const stack = typeof raw.stack === 'string' && stackParts(raw.stack.trim()) ? raw.stack.trim() : null;
	return { version, stack };
}

/** Quotes one argument for the shell a terminal opens (`win32`: PowerShell and cmd both honor double quotes). */
export function quoteArg(arg: string, platform: string = process.platform): string {
	// A backslash is a path separator on Windows but an escape character in POSIX shells.
	const plain = platform === 'win32' ? /^[A-Za-z0-9_@%+=:,./\\-]+$/ : /^[A-Za-z0-9_@%+=:,./-]+$/;
	if (plain.test(arg)) {
		return arg;
	}
	if (platform === 'win32') {
		return `"${arg.replace(/"/g, '""')}"`;
	}
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command line typed into a terminal to run an action: `<pf> deploy staging`. */
export function commandLine(pf: string, argv: string[], platform: string = process.platform): string {
	return [pf, ...argv].map(a => quoteArg(a, platform)).join(' ');
}

/**
 * `current` PATH with the `extra` directories appended when missing. A GUI-launched editor has a short
 * PATH without node, and pf is a `#!/usr/bin/env node` script, so it needs the usual install places.
 */
export function mergePath(current: string | undefined, extra: readonly string[], sep: string = process.platform === 'win32' ? ';' : ':'): string {
	const parts = (current ?? '').split(sep).filter(p => p !== '');
	for (const dir of extra) {
		if (dir !== '' && !parts.includes(dir)) {
			parts.push(dir);
		}
	}
	return parts.join(sep);
}

/** True when pf itself started but its `node` (or another interpreter) was not on PATH (exit 127, `env: node: No such file`). */
export function isMissingInterpreter(code: unknown, stderr: string): boolean {
	return code === 127 && /no such file or directory|not found/i.test(stderr);
}

/** Where the action list stands (`ActionsService.status` has this shape). */
export type ActionsStatusInfo =
	| { type: 'ready' | 'loading' | 'no-pf' | 'old-pf' }
	| { type: 'unavailable' | 'error'; reason: string };

/** The sentence the settings page shows when the list cannot be used (empty while it can). */
export function statusNotice(status: ActionsStatusInfo): string {
	switch (status.type) {
		case 'no-pf':
			return 'pf was not found. Install pf (or set bgTone.pfPath) to choose repo action buttons.';
		case 'old-pf':
			return 'This pf has no actions command yet. Run pf update, then refresh.';
		case 'unavailable':
			return `Repo actions are not available here (${status.reason}).`;
		case 'error':
			return `Could not read the repo actions: ${status.reason}`;
		default:
			return '';
	}
}

/** What the "edit featured" picker changed: ids to feature and ids to unfeature. */
export function diffFeatured(all: readonly RepoAction[], selectedIds: string[]): { feature: string[]; unfeature: string[] } {
	const selected = new Set(selectedIds);
	return {
		feature: all.filter(a => selected.has(a.id) && !a.featured).map(a => a.id),
		unfeature: all.filter(a => !selected.has(a.id) && a.featured).map(a => a.id),
	};
}
