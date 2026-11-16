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
	/** The pf arguments that run it. */
	argv: string[];
}

export type ParsedActions =
	| { ok: true; repo: string | null; actions: RepoAction[] }
	| { ok: false; reason: string };

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
	return { ok: true, repo: typeof doc.repo === 'string' ? doc.repo : null, actions };
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
