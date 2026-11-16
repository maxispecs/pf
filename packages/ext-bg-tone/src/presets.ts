import { parseHex, toHex } from './color.ts';

export interface Preset {
	label: string;
	color: string;
	group: string;
}

/** The original quick-pick colors; kept first so the quick pick order is unchanged. */
const CORE: ReadonlyArray<Preset> = [
	{ label: 'Blue', color: '#3b82f6', group: 'Core' },
	{ label: 'Green', color: '#22c55e', group: 'Core' },
	{ label: 'Red', color: '#ef4444', group: 'Core' },
	{ label: 'Orange', color: '#f97316', group: 'Core' },
	{ label: 'Purple', color: '#a855f7', group: 'Core' },
	{ label: 'Pink', color: '#ec4899', group: 'Core' },
	{ label: 'Teal', color: '#14b8a6', group: 'Core' },
	{ label: 'Yellow', color: '#eab308', group: 'Core' },
	{ label: 'Amber', color: '#f59e0b', group: 'Core' },
	{ label: 'Lime', color: '#84cc16', group: 'Core' },
	{ label: 'Emerald', color: '#10b981', group: 'Core' },
	{ label: 'Cyan', color: '#06b6d4', group: 'Core' },
	{ label: 'Sky', color: '#0ea5e9', group: 'Core' },
	{ label: 'Indigo', color: '#6366f1', group: 'Core' },
	{ label: 'Violet', color: '#8b5cf6', group: 'Core' },
	{ label: 'Fuchsia', color: '#d946ef', group: 'Core' },
	{ label: 'Rose', color: '#f43f5e', group: 'Core' },
	{ label: 'Slate', color: '#64748b', group: 'Core' },
];

const MORE: ReadonlyArray<Preset> = [
	// Deep
	{ label: 'Navy', color: '#1e3a8a', group: 'Deep' },
	{ label: 'Forest', color: '#166534', group: 'Deep' },
	{ label: 'Crimson', color: '#b91c1c', group: 'Deep' },
	{ label: 'Burnt Orange', color: '#c2410c', group: 'Deep' },
	{ label: 'Royal Purple', color: '#6b21a8', group: 'Deep' },
	{ label: 'Plum', color: '#9d174d', group: 'Deep' },
	{ label: 'Deep Teal', color: '#0f766e', group: 'Deep' },
	{ label: 'Olive', color: '#4d7c0f', group: 'Deep' },
	{ label: 'Brown', color: '#92400e', group: 'Deep' },
	{ label: 'Charcoal', color: '#334155', group: 'Deep' },
	// Bright
	{ label: 'Electric Blue', color: '#2563eb', group: 'Bright' },
	{ label: 'Mint', color: '#34d399', group: 'Bright' },
	{ label: 'Coral', color: '#fb7185', group: 'Bright' },
	{ label: 'Tangerine', color: '#fb923c', group: 'Bright' },
	{ label: 'Lavender', color: '#c084fc', group: 'Bright' },
	{ label: 'Hot Pink', color: '#f472b6', group: 'Bright' },
	{ label: 'Aqua', color: '#2dd4bf', group: 'Bright' },
	{ label: 'Gold', color: '#facc15', group: 'Bright' },
	{ label: 'Chartreuse', color: '#a3e635', group: 'Bright' },
	{ label: 'Sky Blue', color: '#38bdf8', group: 'Bright' },
	// Neutral
	{ label: 'Stone', color: '#78716c', group: 'Neutral' },
	{ label: 'Zinc', color: '#71717a', group: 'Neutral' },
	{ label: 'Gray', color: '#6b7280', group: 'Neutral' },
	{ label: 'Sand', color: '#d6a35c', group: 'Neutral' },
	{ label: 'Clay', color: '#b45f4d', group: 'Neutral' },
	{ label: 'Steel', color: '#4682b4', group: 'Neutral' },
];

export const BUILTIN_PRESETS: ReadonlyArray<Preset> = [...CORE, ...MORE];

export const CUSTOM_GROUP = 'Custom';

/** Normalizes a hex value to lowercase #rrggbb, or undefined if invalid. */
export function normalizeHex(input: unknown): string | undefined {
	if (typeof input !== 'string') {
		return undefined;
	}
	const rgb = parseHex(input);
	return rgb ? toHex(rgb) : undefined;
}

/**
 * Parses the user `bgTone.palette` setting: an array of { label?, color }.
 * Invalid entries are dropped; a bare hex string is also accepted.
 */
export function parsePalette(input: unknown): Preset[] {
	if (!Array.isArray(input)) {
		return [];
	}
	const out: Preset[] = [];
	for (const item of input) {
		let color: string | undefined;
		let label: string | undefined;
		if (typeof item === 'string') {
			color = normalizeHex(item);
		} else if (item && typeof item === 'object') {
			const entry = item as Record<string, unknown>;
			color = normalizeHex(entry.color);
			if (typeof entry.label === 'string' && entry.label.trim() !== '') {
				label = entry.label.trim();
			}
		}
		if (color) {
			out.push({ label: label ?? color, color, group: CUSTOM_GROUP });
		}
	}
	return out;
}

/** Built-in presets plus the user palette, deduplicated by color (built-ins win). */
export function mergePalette(userPalette: unknown): Preset[] {
	const seen = new Set<string>();
	const merged: Preset[] = [];
	for (const preset of [...BUILTIN_PRESETS, ...parsePalette(userPalette)]) {
		const key = preset.color.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		merged.push(preset);
	}
	return merged;
}
