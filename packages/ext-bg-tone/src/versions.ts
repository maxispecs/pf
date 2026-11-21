/**
 * Pure logic for the Versions section: read `versions.json` (kept by the `ver` CLI), plan a bump the way
 * the CLI does, and decide whether the stack was already bumped since the last commit. No `vscode` import.
 *
 * Only `versions.json` is edited here; `pf ver sync` then rewrites the manifests and runs the hooks.
 */
import { parseStackVersion } from './stackVersion.ts';

/** Where the Versions section shows (`bgTone.versions`): its own view in Source Control, inside the card there, or nowhere. */
export type VersionsPlacement = 'view' | 'card' | 'off';

export function normalizePlacement(value: unknown): VersionsPlacement {
	return value === 'card' || value === 'off' ? value : 'view';
}

export type VersionPart = 'major' | 'minor';
export const VERSION_PARTS: readonly VersionPart[] = ['major', 'minor'];
export const STACK_TARGET = 'stack';

const MAJOR_MINOR = /^(\d+)\.(\d+)$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Entry {
	version: string;
	since?: string;
	type?: string;
	[key: string]: unknown;
}

export interface VersionsFile {
	/** The whole parsed file, so keys this code does not know (`hooks`) survive a write. */
	data: Record<string, unknown> & { stack: Entry; packages: Record<string, Entry> };
	stack: Entry;
	packages: Record<string, Entry>;
	/** The `featured` array (the ver CLI's `feature`): package paths to list first, in order. Unknown paths are skipped. */
	featured: string[];
}

const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

function isEntry(value: unknown): value is Entry {
	return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Entry).version === 'string' && MAJOR_MINOR.test((value as Entry).version);
}

/** The file as the CLI reads it: a `major.minor` stack and packages. `undefined` for anything else (nothing is guessed). */
export function parseVersionsFile(text: string | null): VersionsFile | undefined {
	if (text === null) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const data = parsed as Record<string, unknown>;
	if (!isEntry(data.stack)) {
		return undefined;
	}
	const rawPackages = data.packages ?? {};
	if (!rawPackages || typeof rawPackages !== 'object' || Array.isArray(rawPackages)) {
		return undefined;
	}
	for (const entry of Object.values(rawPackages)) {
		if (!isEntry(entry)) {
			return undefined;
		}
	}
	data.packages = rawPackages;
	// A malformed `featured` is the CLI's error to report; here it only means nothing is featured (and it is kept on write).
	const rawFeatured = data.featured;
	const featured =
		Array.isArray(rawFeatured) && rawFeatured.every(x => typeof x === 'string')
			? rawFeatured.filter((x, i) => rawFeatured.indexOf(x) === i && has(rawPackages, x))
			: [];
	return { data: data as VersionsFile['data'], stack: data.stack, packages: data.packages as Record<string, Entry>, featured };
}

/** `major.minor` after a bump: major gives `X+1.0`, minor gives `X.Y+1`. */
export function bumpVersion(version: string, part: VersionPart): string {
	const m = MAJOR_MINOR.exec(version);
	if (!m) {
		throw new Error(`not a major.minor version: ${version}`);
	}
	const major = Number(m[1]);
	const minor = Number(m[2]);
	return part === 'major' ? `${major + 1}.0` : `${major}.${minor + 1}`;
}

/** Local calendar date, `YYYY-MM-DD` (what the CLI stamps as `since`). */
export function localDate(now: Date = new Date()): string {
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

/** The CLI's `stampVersion`: `version`, `since`, `type` first, then every other key in its order. */
function stamp(entry: Entry, version: string, since: string): Entry {
	const next: Entry = { version, since };
	if (entry.type) {
		next.type = entry.type;
	}
	for (const [key, value] of Object.entries(entry)) {
		if (key !== 'version' && key !== 'since' && key !== 'type') {
			next[key] = value;
		}
	}
	return next;
}

export function isVersionPart(value: unknown): value is VersionPart {
	return value === 'major' || value === 'minor';
}

/** True for `stack` or a package path of this file (own keys only). */
export function isTarget(file: VersionsFile, target: unknown): target is string {
	return typeof target === 'string' && (target === STACK_TARGET || has(file.packages, target));
}

export type VersionChange = { target: string; from: string; to: string };

export type BumpPlan = { ok: true; text: string; changes: VersionChange[] } | { ok: false; reason: string };

/**
 * The new file text for one click. A package bump also raises the stack minor, unless `stackDone` (the stack
 * was already bumped since the last commit). A click on the stack itself always bumps the stack.
 */
export function planBump(
	text: string | null,
	target: unknown,
	part: unknown,
	options: { stackDone: boolean; today?: string },
): BumpPlan {
	const file = parseVersionsFile(text);
	if (!file) {
		return { ok: false, reason: 'versions.json is missing or not a valid ver file' };
	}
	if (!isVersionPart(part)) {
		return { ok: false, reason: 'the part must be major or minor' };
	}
	if (!isTarget(file, target)) {
		return { ok: false, reason: 'unknown target' };
	}
	const today = options.today ?? localDate();
	if (!CALENDAR_DATE.test(today)) {
		return { ok: false, reason: 'bad date' };
	}
	const changes: VersionChange[] = [];
	const { data } = file;
	if (target === STACK_TARGET) {
		const to = bumpVersion(file.stack.version, part);
		changes.push({ target, from: file.stack.version, to });
		data.stack = stamp(file.stack, to, today);
	} else {
		const entry = file.packages[target];
		const to = bumpVersion(entry.version, part);
		changes.push({ target, from: entry.version, to });
		data.packages[target] = stamp(entry, to, today);
		if (!options.stackDone) {
			const stackTo = bumpVersion(file.stack.version, 'minor');
			changes.push({ target: STACK_TARGET, from: file.stack.version, to: stackTo });
			data.stack = stamp(file.stack, stackTo, today);
		}
	}
	const packages = Object.fromEntries(Object.entries(data.packages).sort(([a], [b]) => a.localeCompare(b)));
	return { ok: true, text: `${JSON.stringify({ ...data, packages }, null, 2)}\n`, changes };
}

export type FeaturePlan = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

/**
 * The new file text after featuring (`on`) or unfeaturing a package, like the CLI's `feature` / `unfeature`:
 * a featured package is appended to the `featured` array (so it lists last among the featured), an unfeatured
 * one is removed, and the array sits right after `stack` and is left out when empty. No version changes. The
 * stack cannot be featured. Entries for packages that no longer exist are kept (the CLI warns about them).
 */
export function planFeature(text: string | null, target: unknown, on: unknown): FeaturePlan {
	const file = parseVersionsFile(text);
	if (!file) {
		return { ok: false, reason: 'versions.json is missing or not a valid ver file' };
	}
	if (typeof on !== 'boolean') {
		return { ok: false, reason: 'featuring needs a yes or no' };
	}
	if (typeof target !== 'string' || target === STACK_TARGET || !has(file.packages, target)) {
		return { ok: false, reason: 'unknown package' };
	}
	const raw = file.data.featured;
	if (raw !== undefined && (!Array.isArray(raw) || !raw.every(x => typeof x === 'string'))) {
		return { ok: false, reason: 'the "featured" key of versions.json is not a list of package paths (fix it with the ver CLI)' };
	}
	const list: string[] = raw === undefined ? [] : [...(raw as string[])];
	const at = list.indexOf(target);
	if (on && at < 0) {
		list.push(target);
	} else if (!on && at >= 0) {
		list.splice(at, 1);
	} else {
		return { ok: true, text: text as string, changed: false };
	}
	const packages = Object.fromEntries(Object.entries(file.data.packages).sort(([a], [b]) => a.localeCompare(b)));
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(file.data)) {
		if (key === 'featured') {
			continue;
		}
		out[key] = key === 'packages' ? packages : value;
		if (key === 'stack' && list.length > 0) {
			out.featured = list;
		}
	}
	return { ok: true, text: `${JSON.stringify(out, null, 2)}\n`, changed: true };
}

/**
 * Whether the stack was already bumped since the last commit: `HEAD` has no valid `versions.json`, or its
 * stack version differs from the working copy's. That also counts a bump made from a terminal.
 */
export function stackBumpedSinceHead(headText: string | null | undefined, currentText: string | null): boolean {
	const head = parseStackVersion(headText ?? null);
	const current = parseStackVersion(currentText);
	return head === undefined || current === undefined || head !== current;
}

/** What a click would do, e.g. `minor 1.2 -> 1.3, stack 3.23 -> 3.24`; the stack part is left out when it will not change. */
export function previewBump(file: VersionsFile, target: string, part: VersionPart, stackDone: boolean): string {
	const plan = planBump(JSON.stringify(file.data), target, part, { stackDone, today: '2000-01-01' });
	if (!plan.ok) {
		return '';
	}
	const [first, stack] = plan.changes;
	let out = `${part} ${first.from} -> ${first.to}`;
	if (stack) {
		out += `, stack ${stack.from} -> ${stack.to}`;
	} else if (target !== STACK_TARGET) {
		out += ' (stack already bumped since the last commit)';
	}
	return out;
}

export interface VersionRow {
	/** `stack` or the package path: what a click sends back. */
	target: string;
	/** Shown name: the package's own folder name, without the folder it is stored in (see `shortLabels`). */
	label: string;
	version: string;
	since: string;
	/** A featured package (listed first, name in bold). */
	featured: boolean;
	tips: { major: string; minor: string };
}

/** What the page draws. */
export interface VersionsState {
	rows: VersionRow[];
	/** False when clicking is refused (untrusted workspace, not a local folder). */
	canBump: boolean;
	stackDone: boolean;
	hint: string;
}

export const NO_VERSIONS: VersionsState = { rows: [], canBump: false, stackDone: false, hint: '' };

/**
 * Short names for package paths: the folder a package is stored in (`packages/`, `apps/`, ...) is redundant, so
 * each name is its last path segment. Only when two packages would end up with the same name (`apps/web` and
 * `libs/web`) do they keep as many trailing segments as it takes to tell them apart.
 */
export function shortLabels(paths: string[]): Map<string, string> {
	const parts = new Map(paths.map(p => [p, p.split('/').filter(Boolean)] as const));
	const take = new Map<string, number>(paths.map(p => [p, 1]));
	const label = (p: string) => (parts.get(p) as string[]).slice(-(take.get(p) as number)).join('/') || p;
	for (let round = 0; round < 32; round++) {
		const byLabel = new Map<string, string[]>();
		for (const p of paths) {
			byLabel.set(label(p), [...(byLabel.get(label(p)) ?? []), p]);
		}
		let grew = false;
		for (const group of byLabel.values()) {
			if (group.length < 2) {
				continue;
			}
			for (const p of group) {
				if ((take.get(p) as number) < (parts.get(p) as string[]).length) {
					take.set(p, (take.get(p) as number) + 1);
					grew = true;
				}
			}
		}
		if (!grew) {
			break;
		}
	}
	return new Map(paths.map(p => [p, label(p)] as const));
}

export function versionsState(
	file: VersionsFile | undefined,
	options: { stackDone: boolean; canBump: boolean; hint?: string },
): VersionsState {
	if (!file) {
		return NO_VERSIONS;
	}
	const row = (target: string, label: string, entry: Entry, featured = false): VersionRow => ({
		target,
		label,
		version: entry.version,
		since: typeof entry.since === 'string' ? entry.since : '',
		featured,
		tips: {
			major: previewBump(file, target, 'major', options.stackDone),
			minor: previewBump(file, target, 'minor', options.stackDone),
		},
	});
	// Featured packages first, in the order they were featured (as the CLI lists them); the rest alphabetically.
	const rest = Object.keys(file.packages)
		.filter(p => !file.featured.includes(p))
		.sort((a, b) => a.localeCompare(b));
	const labels = shortLabels([...file.featured, ...rest]);
	return {
		rows: [
			row(STACK_TARGET, STACK_TARGET, file.stack),
			...file.featured.map(p => row(p, labels.get(p) ?? p, file.packages[p], true)),
			...rest.map(p => row(p, labels.get(p) ?? p, file.packages[p])),
		],
		canBump: options.canBump,
		stackDone: options.stackDone,
		hint: options.hint ?? '',
	};
}

/** Accepts only a well-formed state (workspaceState may hold one written by an older version). */
export function parseVersionsState(raw: unknown): VersionsState {
	if (!raw || typeof raw !== 'object') {
		return NO_VERSIONS;
	}
	const s = raw as Partial<VersionsState>;
	if (!Array.isArray(s.rows)) {
		return NO_VERSIONS;
	}
	const rows = s.rows
		.filter(
			(r): r is VersionRow =>
				!!r && typeof r.target === 'string' && typeof r.label === 'string' && typeof r.version === 'string' && typeof r.since === 'string' &&
				!!r.tips && typeof r.tips.major === 'string' && typeof r.tips.minor === 'string',
		)
		.map(r => ({ ...r, featured: r.featured === true }));
	return { rows, canBump: s.canBump === true, stackDone: s.stackDone === true, hint: typeof s.hint === 'string' ? s.hint : '' };
}
