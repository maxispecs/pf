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
	/** The `categories` object (the ver CLI's `category`) in file order. A malformed one (or a bad color) is dropped, not an error. */
	categories: VersionCategory[];
}

/** A category of `versions.json`: a name and an optional `#rgb` / `#rrggbb` color. */
export interface VersionCategory {
	name: string;
	color?: string;
}

const CATEGORY_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The color if it is a plain hex color (what the page may paint with), else undefined. */
export function categoryColor(value: unknown): string | undefined {
	return typeof value === 'string' && CATEGORY_COLOR.test(value) ? value.toLowerCase() : undefined;
}

function parseCategories(raw: unknown): VersionCategory[] {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return [];
	}
	const out: VersionCategory[] = [];
	for (const [name, value] of Object.entries(raw)) {
		if (!name.trim() || name !== name.trim()) {
			continue;
		}
		const color = value && typeof value === 'object' && !Array.isArray(value) ? categoryColor((value as { color?: unknown }).color) : undefined;
		out.push(color ? { name, color } : { name });
	}
	return out;
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
	return {
		data: data as VersionsFile['data'],
		stack: data.stack,
		packages: data.packages as Record<string, Entry>,
		featured,
		categories: parseCategories(data.categories),
	};
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
	return { ok: true, text: composeVersionsText(data), changes };
}

/**
 * The file text as the ver CLI writes it: `featured` and `categories` right after `stack` (each left out when
 * empty), packages sorted by path, every other key where it was. `over` replaces the featured list or the
 * categories object for an edit of those; otherwise they are written as `data` has them.
 */
export function composeVersionsText(
	data: Record<string, unknown> & { packages: Record<string, Entry> },
	over: { featured?: string[]; categories?: Record<string, unknown> } = {},
): string {
	const featured = over.featured ?? data.featured;
	const categories = over.categories ?? data.categories;
	const isEmpty = (value: unknown): boolean =>
		value == null || (Array.isArray(value) ? value.length === 0 : typeof value === 'object' && Object.keys(value).length === 0);
	const packages = Object.fromEntries(Object.entries(data.packages).sort(([a], [b]) => a.localeCompare(b)));
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (key === 'featured' || key === 'categories') {
			continue;
		}
		out[key] = key === 'packages' ? packages : value;
		if (key === 'stack') {
			if (!isEmpty(featured)) {
				out.featured = featured;
			}
			if (!isEmpty(categories)) {
				out.categories = categories;
			}
		}
	}
	return `${JSON.stringify(out, null, 2)}\n`;
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
	return { ok: true, text: composeVersionsText(file.data, { featured: list }), changed: true };
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

/**
 * The version changes not committed yet: every target (stack first, then packages by path) whose version in the
 * working `versions.json` differs from `HEAD`'s. A package `HEAD` does not have is a new package, not a bump.
 * Empty without a `HEAD` copy (no commits, or a new file): there is nothing to compare with.
 */
export function pendingChanges(headText: string | null | undefined, currentText: string | null): VersionChange[] {
	const head = parseVersionsFile(headText ?? null);
	const current = parseVersionsFile(currentText);
	if (!head || !current) {
		return [];
	}
	const changes: VersionChange[] = [];
	if (head.stack.version !== current.stack.version) {
		changes.push({ target: STACK_TARGET, from: head.stack.version, to: current.stack.version });
	}
	for (const target of Object.keys(current.packages).sort((a, b) => a.localeCompare(b))) {
		const before = has(head.packages, target) ? head.packages[target].version : undefined;
		if (before !== undefined && before !== current.packages[target].version) {
			changes.push({ target, from: before, to: current.packages[target].version });
		}
	}
	return changes;
}

/** The ver CLI's commit message: `Bump versions: stack 3.23 -> 3.24, packages/kit 1.4 -> 1.5`. */
export function commitMessage(changes: VersionChange[]): string {
	return `Bump versions: ${changes.map(c => `${c.target} ${c.from} -> ${c.to}`).join(', ')}`;
}

/** Native files `pf ver sync` writes a version into (the stack's are in the repo root). */
const NATIVE_MANIFESTS = ['package.json', 'pyproject.toml', 'composer.json', 'VERSION', 'SKILL.md'];

/**
 * Where a bump of these targets may have written: `versions.json` and the native manifests of each target
 * (repo-relative, `/` separated). Only the ones git sees as changed are committed, so a name a target has no
 * file for costs nothing.
 */
export function versionFileCandidates(changes: VersionChange[], versionsFile: string): string[] {
	const files = new Set<string>([versionsFile]);
	for (const { target } of changes) {
		const dir = target === STACK_TARGET ? '' : target.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
		if (dir.startsWith('/') || dir.split('/').includes('..')) {
			continue; // never a path outside the repo
		}
		for (const name of NATIVE_MANIFESTS) {
			files.add(dir && dir !== '.' ? `${dir}/${name}` : name);
		}
	}
	return [...files];
}

export type HookEvent = 'postSync' | 'preCommit';

/**
 * The commands `versions.json` configures for a hook event (a string or an array of strings, like the CLI
 * reads them). A malformed `hooks` is refused, as the CLI does.
 */
export function hookCommands(file: VersionsFile, event: HookEvent): { ok: true; commands: string[] } | { ok: false; reason: string } {
	const raw = file.data.hooks;
	if (raw === undefined || raw === null) {
		return { ok: true, commands: [] };
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, reason: 'the "hooks" key of versions.json must be an object keyed by postSync or preCommit' };
	}
	for (const key of Object.keys(raw)) {
		if (key !== 'postSync' && key !== 'preCommit') {
			return { ok: false, reason: `unknown hook "${key}" in versions.json` };
		}
	}
	const value = (raw as Record<string, unknown>)[event];
	if (value === undefined) {
		return { ok: true, commands: [] };
	}
	const list = typeof value === 'string' ? [value] : value;
	if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !x.trim())) {
		return { ok: false, reason: `hooks.${event} in versions.json must be a command string or an array of command strings` };
	}
	return { ok: true, commands: list as string[] };
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
	/** The package's category (one of `VersionsState.categories`), left out for none. */
	category?: string;
	/** That category's color, `#rrggbb` / `#rgb`, left out when it has none. */
	color?: string;
	tips: { major: string; minor: string };
}

/** Bumps not committed yet: the commit button's tooltip and the message the commit starts from. */
export interface PendingCommit {
	message: string;
}

/** What the page draws. */
export interface VersionsState {
	rows: VersionRow[];
	/** Set while a bump waits for a commit (the button shows then); null otherwise. */
	pending: PendingCommit | null;
	/** False when clicking is refused (untrusted workspace, not a local folder). */
	canBump: boolean;
	stackDone: boolean;
	hint: string;
	/**
	 * The defined categories in file order. When there are any, the page puts a header before each group of
	 * rows: the featured block (whatever the category), each category, then the packages with none.
	 */
	categories: VersionCategory[];
}

export const NO_VERSIONS: VersionsState = { rows: [], pending: null, canBump: false, stackDone: false, hint: '', categories: [] };

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
	options: { stackDone: boolean; canBump: boolean; hint?: string; pending?: PendingCommit | null },
): VersionsState {
	if (!file) {
		return NO_VERSIONS;
	}
	// A package's category counts only when `categories` defines it (the CLI warns about the others).
	const categoryOf = (entry: Entry): VersionCategory | undefined =>
		typeof entry.category === 'string' ? file.categories.find(c => c.name === entry.category) : undefined;
	const row = (target: string, label: string, entry: Entry, featured = false): VersionRow => {
		const category = target === STACK_TARGET ? undefined : categoryOf(entry);
		return {
			target,
			label,
			version: entry.version,
			since: typeof entry.since === 'string' ? entry.since : '',
			featured,
			...(category ? { category: category.name } : {}),
			...(category?.color ? { color: category.color } : {}),
			tips: {
				major: previewBump(file, target, 'major', options.stackDone),
				minor: previewBump(file, target, 'minor', options.stackDone),
			},
		};
	};
	// Featured packages first, in the order they were featured (as the CLI lists them), whatever their category.
	// The rest follow grouped by category in the `categories` order, alphabetically inside a group, then the
	// ones with no category.
	const unfeatured = Object.keys(file.packages)
		.filter(p => !file.featured.includes(p))
		.sort((a, b) => a.localeCompare(b));
	const rest = [...file.categories.map(c => c.name), undefined].flatMap(name => unfeatured.filter(p => categoryOf(file.packages[p])?.name === name));
	const labels = shortLabels([...file.featured, ...rest]);
	return {
		rows: [
			row(STACK_TARGET, STACK_TARGET, file.stack),
			...file.featured.map(p => row(p, labels.get(p) ?? p, file.packages[p], true)),
			...rest.map(p => row(p, labels.get(p) ?? p, file.packages[p])),
		],
		pending: options.pending ?? null,
		canBump: options.canBump,
		stackDone: options.stackDone,
		hint: options.hint ?? '',
		categories: file.categories,
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
		.map(r => {
			// A category name is text and a color only ever a plain hex color: the page paints with it.
			const { category, color, ...base } = r;
			const hex = categoryColor(color);
			return {
				...base,
				featured: r.featured === true,
				...(typeof category === 'string' && category.trim() ? { category } : {}),
				...(typeof category === 'string' && category.trim() && hex ? { color: hex } : {}),
			};
		});
	const categories = Array.isArray(s.categories)
		? s.categories.flatMap((c): VersionCategory[] => {
				if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim()) {
					return [];
				}
				const hex = categoryColor(c.color);
				return [hex ? { name: c.name, color: hex } : { name: c.name }];
			})
		: [];
	const pending = s.pending && typeof s.pending === 'object' && typeof s.pending.message === 'string' ? { message: s.pending.message } : null;
	return { rows, pending, canBump: s.canBump === true, stackDone: s.stackDone === true, hint: typeof s.hint === 'string' ? s.hint : '', categories };
}
