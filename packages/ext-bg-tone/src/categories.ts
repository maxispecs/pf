/**
 * Pure logic for editing the categories of `versions.json` from the Versions pane: give a package a category,
 * and add, recolor, rename, move or remove a category. The same file format as the ver CLI's `category` and
 * `categorize` (see `skill-version`). Nothing here changes a version, so no `pf ver sync` follows. No `vscode`.
 */
import { categoryColor, composeVersionsText, parseVersionsFile } from './versions.ts';
import type { VersionsFile } from './versions.ts';

/** Colors offered when a category gets one; any `#rgb` / `#rrggbb` is also accepted. */
export const CATEGORY_PALETTE: readonly { label: string; color: string }[] = [
	{ label: 'Blue', color: '#4aa3ff' },
	{ label: 'Teal', color: '#2bb8a6' },
	{ label: 'Green', color: '#5cb85c' },
	{ label: 'Yellow', color: '#e0b030' },
	{ label: 'Orange', color: '#f0883e' },
	{ label: 'Red', color: '#e5534b' },
	{ label: 'Pink', color: '#e86aa8' },
	{ label: 'Purple', color: '#b180d7' },
	{ label: 'Gray', color: '#8b949e' },
];

export type CategoryPlan = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

/** What the pane can do to the categories of the file. */
export type CategoryEdit =
	| { kind: 'add'; name: string; color?: string }
	| { kind: 'color'; name: string; color: string | null }
	| { kind: 'rename'; name: string; to: string }
	| { kind: 'move'; name: string; by: -1 | 1 }
	| { kind: 'remove'; name: string };

const BAD_FILE = 'versions.json is missing or not a valid ver file';
const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Why a category name is not acceptable (the CLI's rule), or undefined when it is fine. */
export function categoryNameProblem(name: unknown): string | undefined {
	if (typeof name !== 'string' || !name.trim()) {
		return 'the name is empty';
	}
	if (name !== name.trim()) {
		return 'the name has leading or trailing spaces';
	}
	if (/[\x00-\x1f]/.test(name)) {
		return 'the name has control characters';
	}
	return undefined;
}

/** The validation message for an input box (undefined = fine). `except` is the name being renamed (it may stay). */
export function validateCategoryName(value: string, existing: readonly string[], except?: string): string | undefined {
	const problem = categoryNameProblem(value);
	if (problem) {
		return problem.charAt(0).toUpperCase() + problem.slice(1) + '.';
	}
	return existing.includes(value) && value !== except ? `A category named "${value}" already exists.` : undefined;
}

/** The validation message for a color input box: a plain `#rgb` / `#rrggbb`. */
export function validateCategoryColor(value: string): string | undefined {
	return categoryColor(value.trim()) ? undefined : 'Enter a hex color: #rgb or #rrggbb.';
}

/** The categories object as it is in the file (names -> objects), keeping what is there and dropping nothing unknown. */
function rawCategories(file: VersionsFile): Record<string, Record<string, unknown>> {
	const raw = file.data.categories;
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('the "categories" key of versions.json is not an object (fix it with the ver CLI)');
	}
	const out: Record<string, Record<string, unknown>> = {};
	for (const [name, value] of Object.entries(raw)) {
		out[name] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
	}
	return out;
}

/** Puts a package in a category (`null` takes it out), like the CLI's `categorize`. */
export function planCategorize(text: string | null, target: unknown, category: unknown): CategoryPlan {
	const file = parseVersionsFile(text);
	if (!file) {
		return { ok: false, reason: BAD_FILE };
	}
	if (typeof target !== 'string' || !has(file.packages, target)) {
		return { ok: false, reason: 'unknown package' };
	}
	let categories: Record<string, Record<string, unknown>>;
	try {
		categories = rawCategories(file);
	} catch (e) {
		return { ok: false, reason: (e as Error).message };
	}
	if (category !== null && (typeof category !== 'string' || !has(categories, category))) {
		return { ok: false, reason: 'unknown category' };
	}
	const entry = file.data.packages[target];
	if ((entry.category ?? null) === category) {
		return { ok: true, text: text as string, changed: false };
	}
	if (category === null) {
		delete entry.category;
	} else {
		entry.category = category;
	}
	return { ok: true, text: composeVersionsText(file.data), changed: true };
}

/** One edit of the categories object (the file order is the group order). Packages follow a rename or a removal. */
export function planCategoryEdit(text: string | null, edit: CategoryEdit): CategoryPlan {
	const file = parseVersionsFile(text);
	if (!file) {
		return { ok: false, reason: BAD_FILE };
	}
	let categories: Record<string, Record<string, unknown>>;
	try {
		categories = rawCategories(file);
	} catch (e) {
		return { ok: false, reason: (e as Error).message };
	}
	const names = Object.keys(categories);
	const done = (next: Record<string, Record<string, unknown>>): CategoryPlan => ({
		ok: true,
		text: composeVersionsText(file.data, { categories: next }),
		changed: true,
	});
	if (!edit || typeof edit !== 'object') {
		return { ok: false, reason: 'unknown edit' };
	}
	const name = (edit as { name?: unknown }).name;
	if (edit.kind === 'add') {
		const problem = categoryNameProblem(name);
		if (problem) {
			return { ok: false, reason: problem };
		}
		if (has(categories, edit.name)) {
			return { ok: false, reason: `"${edit.name}" already exists` };
		}
		if (edit.color !== undefined && !categoryColor(edit.color)) {
			return { ok: false, reason: 'the color must be #rgb or #rrggbb' };
		}
		return done({ ...categories, [edit.name]: edit.color ? { color: categoryColor(edit.color) } : {} });
	}
	if (typeof name !== 'string' || !has(categories, name)) {
		return { ok: false, reason: 'unknown category' };
	}
	switch (edit.kind) {
		case 'color': {
			const next = { ...categories[name] };
			if (edit.color === null) {
				delete next.color;
			} else if (categoryColor(edit.color)) {
				next.color = categoryColor(edit.color);
			} else {
				return { ok: false, reason: 'the color must be #rgb or #rrggbb' };
			}
			if (next.color === categories[name].color) {
				return { ok: true, text: text as string, changed: false };
			}
			return done({ ...categories, [name]: next });
		}
		case 'rename': {
			const problem = categoryNameProblem(edit.to);
			if (problem) {
				return { ok: false, reason: problem };
			}
			if (edit.to === name) {
				return { ok: true, text: text as string, changed: false };
			}
			if (has(categories, edit.to)) {
				return { ok: false, reason: `"${edit.to}" already exists` };
			}
			// The key keeps its place in the order.
			const next = Object.fromEntries(Object.entries(categories).map(([key, value]) => [key === name ? edit.to : key, value]));
			for (const entry of Object.values(file.data.packages)) {
				if (entry.category === name) {
					entry.category = edit.to;
				}
			}
			return done(next);
		}
		case 'move': {
			const at = names.indexOf(name);
			const to = at + (edit.by === -1 ? -1 : 1);
			if (to < 0 || to >= names.length) {
				return { ok: true, text: text as string, changed: false };
			}
			[names[at], names[to]] = [names[to], names[at]];
			return done(Object.fromEntries(names.map(key => [key, categories[key]])));
		}
		case 'remove': {
			const rest = Object.fromEntries(Object.entries(categories).filter(([key]) => key !== name));
			for (const entry of Object.values(file.data.packages)) {
				if (entry.category === name) {
					delete entry.category;
				}
			}
			return done(rest);
		}
		default:
			return { ok: false, reason: 'unknown edit' };
	}
}

/** How many packages are in each defined category (what the manager's list shows). */
export function categoryCounts(file: VersionsFile): Map<string, number> {
	const counts = new Map<string, number>(file.categories.map(c => [c.name, 0] as const));
	for (const entry of Object.values(file.packages)) {
		if (typeof entry.category === 'string' && counts.has(entry.category)) {
			counts.set(entry.category, (counts.get(entry.category) as number) + 1);
		}
	}
	return counts;
}
