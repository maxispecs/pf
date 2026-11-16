export interface Rgb {
	r: number;
	g: number;
	b: number;
}

export const MAX_STRENGTH = 0.3;
export const DEFAULT_STRENGTH = 0.08;
export const DEFAULT_DARK_BASE = '#1e1e1e';
export const DEFAULT_LIGHT_BASE = '#ffffff';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parses #rgb, #rgba, #rrggbb or #rrggbbaa. Alpha is ignored.
 * Returns undefined for anything else.
 */
export function parseHex(input: string | undefined | null): Rgb | undefined {
	if (typeof input !== 'string') {
		return undefined;
	}
	const value = input.trim();
	const match = HEX_RE.exec(value);
	if (!match) {
		return undefined;
	}
	let digits = match[1];
	if (digits.length === 3 || digits.length === 4) {
		digits = digits.split('').map(c => c + c).join('');
	}
	return {
		r: parseInt(digits.slice(0, 2), 16),
		g: parseInt(digits.slice(2, 4), 16),
		b: parseInt(digits.slice(4, 6), 16),
	};
}

function clampByte(n: number): number {
	return Math.max(0, Math.min(255, Math.round(n)));
}

export function toHex({ r, g, b }: Rgb): string {
	const part = (n: number) => clampByte(n).toString(16).padStart(2, '0');
	return `#${part(r)}${part(g)}${part(b)}`;
}

/** Clamps strength into [0, MAX_STRENGTH]; non-finite values fall back to the default. */
export function normalizeStrength(strength: unknown): number {
	if (typeof strength !== 'number' || !Number.isFinite(strength)) {
		return DEFAULT_STRENGTH;
	}
	return Math.max(0, Math.min(MAX_STRENGTH, strength));
}

/** Linear sRGB-component mix: base * (1 - s) + tone * s. */
export function blend(base: Rgb, tone: Rgb, strength: number): Rgb {
	const s = Math.max(0, Math.min(1, strength));
	return {
		r: base.r * (1 - s) + tone.r * s,
		g: base.g * (1 - s) + tone.g * s,
		b: base.b * (1 - s) + tone.b * s,
	};
}

/** Blends two hex colors; returns undefined if either is invalid. */
export function blendHex(baseHex: string, toneHex: string, strength: number): string | undefined {
	const base = parseHex(baseHex);
	const tone = parseHex(toneHex);
	if (!base || !tone) {
		return undefined;
	}
	return toHex(blend(base, tone, strength));
}

export type ThemeKindName = 'dark' | 'light' | 'highContrast' | 'highContrastLight';

/** UI areas that can be tinted. */
export type Surface =
	| 'sideBar'
	| 'titleBar'
	| 'editor'
	| 'activityBar'
	| 'statusBar'
	| 'tabBar'
	| 'panel';

/** Order matters: it is the order in which surfaces are reported and applied. */
export const ALL_SURFACES: readonly Surface[] = [
	'sideBar',
	'titleBar',
	'editor',
	'activityBar',
	'statusBar',
	'tabBar',
	'panel',
];
export const DEFAULT_SURFACES: readonly Surface[] = ['sideBar', 'titleBar'];

/** The workbench.colorCustomizations keys each surface controls. */
export const SURFACE_KEYS: Record<Surface, readonly string[]> = {
	sideBar: ['sideBar.background'],
	titleBar: ['titleBar.activeBackground', 'titleBar.inactiveBackground'],
	editor: ['editor.background'],
	activityBar: ['activityBar.background'],
	statusBar: ['statusBar.background'],
	tabBar: ['editorGroupHeader.tabsBackground'],
	panel: ['panel.background'],
};

/** Keys set to the raw tone color (not blended) when `accentBorder` is on. */
export const ACCENT_KEYS: readonly string[] = ['titleBar.border', 'tab.activeBorder'];

/** Every colorCustomizations key this extension may manage. */
export const OWNED_KEYS: readonly string[] = [
	...ALL_SURFACES.flatMap(s => SURFACE_KEYS[s]),
	...ACCENT_KEYS,
];

/**
 * Surfaces whose default base is already a saturated color (the blue status bar), so the
 * normal subtle strength would be invisible. Their strength is multiplied by this factor.
 */
const STRENGTH_SCALE: Partial<Record<Surface, number>> = {
	statusBar: 5,
};

/** Default theme backgrounds (VS Code Dark+/Light+) used as the blend base. */
const SURFACE_BASES: Record<Surface, { dark: string; light: string }> = {
	sideBar: { dark: '#252526', light: '#f3f3f3' },
	titleBar: { dark: '#3c3c3c', light: '#dddddd' },
	editor: { dark: DEFAULT_DARK_BASE, light: DEFAULT_LIGHT_BASE },
	activityBar: { dark: '#333333', light: '#2c2c2c' },
	statusBar: { dark: '#007acc', light: '#007acc' },
	tabBar: { dark: '#252526', light: '#f3f3f3' },
	panel: { dark: DEFAULT_DARK_BASE, light: DEFAULT_LIGHT_BASE },
};

export function defaultBaseFor(kind: ThemeKindName, surface: Surface = 'editor'): string | undefined {
	switch (kind) {
		case 'dark':
			return SURFACE_BASES[surface].dark;
		case 'light':
			return SURFACE_BASES[surface].light;
		default:
			return undefined; // high contrast themes are not tinted
	}
}

/** FNV-1a 32-bit hash. */
export function hashString(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
	const hue = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0, g = 0, b = 0;
	if (hue < 60) { r = c; g = x; }
	else if (hue < 120) { r = x; g = c; }
	else if (hue < 180) { g = c; b = x; }
	else if (hue < 240) { g = x; b = c; }
	else if (hue < 300) { r = x; b = c; }
	else { r = c; b = x; }
	return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Stable, distinct color derived from a name (e.g. the workspace folder name). */
export function colorFromName(name: string): string {
	const hue = hashString(name) % 360;
	return toHex(hslToRgb(hue, 0.65, 0.5));
}

export interface ToneSettings {
	enabled: boolean;
	color: string;
	strength: unknown;
	/** Which surfaces to tint. Unknown entries are ignored. */
	surfaces: unknown;
	/** Optional per-surface hex base overrides, e.g. { "sideBar": "#f5f5f5" }. */
	baseColors: unknown;
	/** Also paint the title bar bottom border and active tab border with the raw tone. */
	accentBorder?: boolean;
}

export type TintResult =
	/** Apply these colorCustomizations values (key -> hex). */
	| { type: 'tint'; values: Record<string, string> }
	/** Nothing should be applied; remove any previously applied values. */
	| { type: 'none' }
	/** Settings are invalid; leave the current state alone and warn. */
	| { type: 'invalid'; message: string };

export function normalizeSurfaces(input: unknown): Surface[] {
	if (!Array.isArray(input)) {
		return [...DEFAULT_SURFACES];
	}
	return ALL_SURFACES.filter(s => input.includes(s));
}

/** Computes the colorCustomizations values for the given settings and theme kind. */
export function resolveTint(settings: ToneSettings, kind: ThemeKindName): TintResult {
	const color = (settings.color ?? '').trim();
	if (!settings.enabled || color === '') {
		return { type: 'none' };
	}
	if (!parseHex(color)) {
		return { type: 'invalid', message: `bgTone.color "${color}" is not a valid hex color (use #rgb or #rrggbb).` };
	}

	const overrides: Record<string, unknown> =
		settings.baseColors && typeof settings.baseColors === 'object' && !Array.isArray(settings.baseColors)
			? (settings.baseColors as Record<string, unknown>)
			: {};
	const strength = normalizeStrength(settings.strength);
	const values: Record<string, string> = {};

	for (const surface of normalizeSurfaces(settings.surfaces)) {
		const override = overrides[surface];
		let base: string | undefined;
		if (typeof override === 'string' && override.trim() !== '') {
			if (!parseHex(override)) {
				return { type: 'invalid', message: `bgTone.baseColors.${surface} "${override}" is not a valid hex color (use #rgb or #rrggbb).` };
			}
			base = override.trim();
		} else {
			base = defaultBaseFor(kind, surface);
		}
		if (!base) {
			continue;
		}
		const value = blendHex(base, color, Math.min(1, strength * (STRENGTH_SCALE[surface] ?? 1)));
		if (value) {
			for (const key of SURFACE_KEYS[surface]) {
				values[key] = value;
			}
		}
	}

	// High contrast themes rely on their own borders, so they are never accented.
	if (settings.accentBorder === true && (kind === 'dark' || kind === 'light')) {
		const accent = parseHex(color);
		if (accent) {
			for (const key of ACCENT_KEYS) {
				values[key] = toHex(accent);
			}
		}
	}

	return Object.keys(values).length > 0 ? { type: 'tint', values } : { type: 'none' };
}
