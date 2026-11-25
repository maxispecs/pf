import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Image types a repo logo may use. SVG renders crisp at any size. */
export const LOGO_EXTENSIONS: readonly string[] = ['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif', '.ico'];

/** Places the logo can be shown. `windowTitle` uses the emoji/text prefix, never the image itself. */
export type LogoLocation = 'identityCard' | 'explorerItem' | 'scmCard' | 'windowTitle';

export const ALL_LOGO_LOCATIONS: readonly LogoLocation[] = ['identityCard', 'explorerItem', 'scmCard', 'windowTitle'];
export const DEFAULT_LOGO_LOCATIONS: readonly LogoLocation[] = ['identityCard', 'explorerItem', 'scmCard'];

export type LogoPathResult =
	| { ok: true; path: string }
	| { ok: false; reason: string };

/**
 * Validates a workspace-relative logo path from settings. Returns a normalized, forward-slash
 * path. Rejects absolute paths, parent traversal and unsupported extensions so a committed
 * setting can never point outside the repo.
 */
export function validateLogoPath(raw: unknown): LogoPathResult {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return { ok: false, reason: 'No logo set.' };
	}
	const value = raw.trim().replace(/\\/g, '/');
	if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.startsWith('~') || value.includes('\0')) {
		return { ok: false, reason: 'Logo path must be relative to the repo root.' };
	}
	const normalized = path.posix.normalize(value);
	if (normalized === '..' || normalized.startsWith('../') || normalized === '.' || normalized.endsWith('/')) {
		return { ok: false, reason: 'Logo path must point to a file inside the repo.' };
	}
	const ext = path.posix.extname(normalized).toLowerCase();
	if (!LOGO_EXTENSIONS.includes(ext)) {
		return { ok: false, reason: `Logo must be one of: ${LOGO_EXTENSIONS.join(', ')}.` };
	}
	return { ok: true, path: normalized };
}

/**
 * Converts an absolute file path into a workspace-relative, forward-slash path.
 * Returns undefined if the file is outside the root (e.g. picked from elsewhere on disk).
 */
export function toRelativeLogoPath(rootFsPath: string, fileFsPath: string): string | undefined {
	const relative = path.relative(rootFsPath, fileFsPath);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		return undefined;
	}
	const posix = relative.split(path.sep).join('/');
	const result = validateLogoPath(posix);
	return result.ok ? result.path : undefined;
}

/** A drag carries one file or a few; a longer list from the page is cut. */
const MAX_DROPPED_ITEMS = 50;
const MAX_DROPPED_LENGTH = 4096;

export type LogoDropResult =
	| { ok: true; path: string }
	| { ok: false; reason: 'none' | 'outside' | 'type' };

/** A dropped `file:` URI or absolute path as a file system path; anything else (other schemes, relative text) is not a file. */
function droppedFsPath(item: unknown): string | undefined {
	if (typeof item !== 'string' || item === '' || item.length > MAX_DROPPED_LENGTH || item.includes('\0')) {
		return undefined;
	}
	if (/^file:/i.test(item)) {
		try {
			return fileURLToPath(item);
		} catch {
			return undefined;
		}
	}
	return path.isAbsolute(item) ? path.normalize(item) : undefined;
}

/**
 * The logo path for what was dropped on the Repo Identity card (`file:` URIs or absolute paths, as the page read them
 * from the drag). The first image inside the root wins. Otherwise the reason: `type` when a dropped file is inside the
 * repo but not an image, `outside` when the files are elsewhere, `none` when nothing was a file.
 */
export function logoPathFromDrop(rootFsPath: string, dropped: unknown): LogoDropResult {
	if (!Array.isArray(dropped)) {
		return { ok: false, reason: 'none' };
	}
	let reason: 'none' | 'outside' | 'type' = 'none';
	for (const item of dropped.slice(0, MAX_DROPPED_ITEMS)) {
		const file = droppedFsPath(item);
		if (!file) {
			continue;
		}
		const rel = toRelativeLogoPath(rootFsPath, file);
		if (rel) {
			return { ok: true, path: rel };
		}
		const relative = path.relative(rootFsPath, file);
		const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
		if (inside) {
			reason = 'type';
		} else if (reason === 'none') {
			reason = 'outside';
		}
	}
	return { ok: false, reason };
}

export function normalizeLogoLocations(input: unknown): LogoLocation[] {
	if (!Array.isArray(input)) {
		return [...DEFAULT_LOGO_LOCATIONS];
	}
	return ALL_LOGO_LOCATIONS.filter(l => input.includes(l));
}

const MAX_TITLE_PREFIX_CHARS = 8;

/** Cleans the title prefix: trimmed, no variable syntax, limited length. Empty if unusable. */
export function normalizeTitlePrefix(input: unknown): string {
	if (typeof input !== 'string') {
		return '';
	}
	const cleaned = input.replace(/\$\{[^}]*\}?/g, '').replace(/[\r\n\t]+/g, ' ').trim();
	return Array.from(cleaned).slice(0, MAX_TITLE_PREFIX_CHARS).join('');
}

/** Default VS Code window.title template, used when the user has not customized it. */
export const DEFAULT_TITLE_TEMPLATE =
	'${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}';

/** Prepends the prefix to a window.title template. */
export function buildWindowTitle(prefix: string, baseTemplate: string | undefined): string | undefined {
	const cleaned = normalizeTitlePrefix(prefix);
	if (cleaned === '') {
		return undefined;
	}
	const base = baseTemplate && baseTemplate.trim() !== '' ? baseTemplate : DEFAULT_TITLE_TEMPLATE;
	return `${cleaned} ${base}`;
}

/**
 * True when `title` looks like one we generated: a short prefix followed by the base template.
 * This lets teammates who cloned a committed `window.title` update or remove it too.
 */
export function isGeneratedTitle(title: string | undefined, baseTemplate: string | undefined): boolean {
	if (!title) {
		return false;
	}
	const base = baseTemplate && baseTemplate.trim() !== '' ? baseTemplate : DEFAULT_TITLE_TEMPLATE;
	const suffix = ` ${base}`;
	if (!title.endsWith(suffix)) {
		return false;
	}
	const prefix = title.slice(0, title.length - suffix.length);
	return prefix !== '' && normalizeTitlePrefix(prefix) === prefix;
}
