import {
	ALL_SURFACES,
	MAX_STRENGTH,
	defaultBaseFor,
	normalizeStrength,
	normalizeSurfaces,
	resolveTint,
	SURFACE_KEYS,
} from './color.ts';
import type { Surface, ThemeKindName, ToneSettings } from './color.ts';
import { normalizeLogoLocations, normalizeTitlePrefix, validateLogoPath } from './logo.ts';
import { normalizeHex } from './presets.ts';

/** Settings keys the settings page is allowed to write. Anything else is rejected. */
export const WRITABLE_KEYS = [
	'enabled',
	'color',
	'strength',
	'surfaces',
	'baseColors',
	'accentBorder',
	'logo',
	'logoLocations',
	'titleEmoji',
] as const;

export type WritableKey = (typeof WRITABLE_KEYS)[number];

export function isWritableKey(key: unknown): key is WritableKey {
	return typeof key === 'string' && (WRITABLE_KEYS as readonly string[]).includes(key);
}

export type Sanitized =
	| { ok: true; value: unknown }
	| { ok: false; reason: string };

/**
 * Validates and normalizes a value coming from the webview before it is written to
 * settings.json. `value: undefined` in the result means "remove the setting".
 */
export function sanitizeSetting(key: WritableKey, value: unknown): Sanitized {
	switch (key) {
		case 'enabled':
		case 'accentBorder':
			return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${key} must be true or false.` };
		case 'color': {
			if (value === '' || value === null || value === undefined) {
				return { ok: true, value: undefined };
			}
			const hex = normalizeHex(value);
			return hex ? { ok: true, value: hex } : { ok: false, reason: 'Enter a valid hex color (#rgb or #rrggbb).' };
		}
		case 'strength':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return { ok: false, reason: `Strength must be a number between 0 and ${MAX_STRENGTH}.` };
			}
			return { ok: true, value: Math.round(normalizeStrength(value) * 1000) / 1000 };
		case 'surfaces':
			if (!Array.isArray(value)) {
				return { ok: false, reason: 'surfaces must be a list.' };
			}
			return { ok: true, value: normalizeSurfaces(value) };
		case 'baseColors': {
			if (value === null || value === undefined) {
				return { ok: true, value: undefined };
			}
			if (typeof value !== 'object' || Array.isArray(value)) {
				return { ok: false, reason: 'baseColors must be an object.' };
			}
			const out: Record<string, string> = {};
			for (const surface of ALL_SURFACES) {
				const raw = (value as Record<string, unknown>)[surface];
				if (raw === undefined || raw === '') {
					continue;
				}
				const hex = normalizeHex(raw);
				if (!hex) {
					return { ok: false, reason: `Base color for ${surface} is not a valid hex color.` };
				}
				out[surface] = hex;
			}
			return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
		}
		case 'logo': {
			if (value === '' || value === null || value === undefined) {
				return { ok: true, value: undefined };
			}
			const result = validateLogoPath(value);
			return result.ok ? { ok: true, value: result.path } : { ok: false, reason: result.reason };
		}
		case 'logoLocations':
			if (!Array.isArray(value)) {
				return { ok: false, reason: 'logoLocations must be a list.' };
			}
			return { ok: true, value: normalizeLogoLocations(value) };
		case 'titleEmoji': {
			if (value === null || value === undefined) {
				return { ok: true, value: undefined };
			}
			if (typeof value !== 'string') {
				return { ok: false, reason: 'titleEmoji must be text.' };
			}
			const cleaned = normalizeTitlePrefix(value);
			return { ok: true, value: cleaned === '' ? undefined : cleaned };
		}
	}
}

/** Display metadata for the surface checklist. */
export const SURFACE_LABELS: Record<Surface, { label: string; hint: string }> = {
	sideBar: { label: 'Side bar', hint: 'Explorer and other side panels' },
	titleBar: { label: 'Title bar', hint: 'The top window bar' },
	editor: { label: 'Editor', hint: 'The main editor background' },
	activityBar: { label: 'Activity bar', hint: 'The icon strip beside the side bar' },
	statusBar: { label: 'Status bar', hint: 'The bottom bar (stronger blend, it starts blue)' },
	tabBar: { label: 'Tab bar', hint: 'The row of editor tabs' },
	panel: { label: 'Panel', hint: 'Terminal, problems and output' },
};

export interface PreviewInput {
	enabled: boolean;
	color: string;
	strength: number;
	surfaces: Surface[];
	baseColors: Partial<Record<Surface, string>>;
	accentBorder: boolean;
}

export interface PreviewResult {
	/** Resolved background per surface (tinted, or the untouched base when not tinted). */
	surfaces: Record<Surface, string>;
	/** Raw tone border color when the accent border is on and applicable. */
	accent: string | undefined;
	/** True when the tone is invalid or the theme kind is never tinted. */
	tinted: boolean;
	/** Message when the settings are invalid. */
	error: string | undefined;
}

const NEUTRAL_FALLBACK = '#808080';

/** Computes what each surface will look like, for the settings page preview. */
export function computePreview(input: PreviewInput, kind: ThemeKindName): PreviewResult {
	const settings: ToneSettings = {
		enabled: input.enabled,
		color: input.color,
		strength: input.strength,
		surfaces: input.surfaces,
		baseColors: input.baseColors,
		accentBorder: input.accentBorder,
	};
	const result = resolveTint(settings, kind);
	const values = result.type === 'tint' ? result.values : {};
	const surfaces = {} as Record<Surface, string>;
	for (const surface of ALL_SURFACES) {
		const tinted = SURFACE_KEYS[surface].map(key => values[key]).find(v => v !== undefined);
		surfaces[surface] = tinted ?? input.baseColors[surface] ?? defaultBaseFor(kind, surface) ?? NEUTRAL_FALLBACK;
	}
	return {
		surfaces,
		accent: values['titleBar.border'],
		tinted: result.type === 'tint',
		error: result.type === 'invalid' ? result.message : undefined,
	};
}
