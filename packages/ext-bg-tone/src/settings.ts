import * as vscode from 'vscode';
import { ALL_SURFACES, Surface, normalizeStrength, normalizeSurfaces, parseHex } from './color.ts';
import { LogoLocation, normalizeLogoLocations, normalizeTitlePrefix } from './logo.ts';
import { normalizeHex } from './presets.ts';
import { applyTone } from './apply.ts';
import { REPO_KEYS, clearLegacyValues, getValue, hasLegacyValues, primaryFolder, writeRepoValues } from './store.ts';

export { primaryFolder };

/** Everything the settings page, identity views and title logic read. */
export interface BgToneConfig {
	enabled: boolean;
	color: string;
	strength: number;
	surfaces: Surface[];
	baseColors: Partial<Record<Surface, string>>;
	accentBorder: boolean;
	logo: string;
	logoLocations: LogoLocation[];
	titleEmoji: string;
	showLastAgent: boolean;
	showLastCommits: boolean;
	showActions: boolean;
	palette: unknown;
}

export function readConfig(): BgToneConfig {
	const rawBases = getValue<unknown>('baseColors', {});
	const baseColors: Partial<Record<Surface, string>> = {};
	if (rawBases && typeof rawBases === 'object' && !Array.isArray(rawBases)) {
		for (const surface of ALL_SURFACES) {
			const hex = normalizeHex((rawBases as Record<string, unknown>)[surface]);
			if (hex) {
				baseColors[surface] = hex;
			}
		}
	}
	const rawColor = getValue<unknown>('color', '');
	const color = (typeof rawColor === 'string' ? rawColor : '').trim();
	return {
		enabled: getValue<unknown>('enabled', true) !== false,
		color: parseHex(color) ? (normalizeHex(color) as string) : color,
		strength: normalizeStrength(getValue<unknown>('strength', undefined) as number | undefined),
		surfaces: normalizeSurfaces(getValue<unknown>('surfaces', undefined)),
		baseColors,
		accentBorder: getValue<unknown>('accentBorder', false) === true,
		logo: String(getValue<unknown>('logo', '') ?? '').trim(),
		logoLocations: normalizeLogoLocations(getValue<unknown>('logoLocations', undefined)),
		titleEmoji: normalizeTitlePrefix(getValue<unknown>('titleEmoji', '')),
		// Personal, not repo data: a VS Code setting.
		showLastAgent: vscode.workspace.getConfiguration('bgTone').get<boolean>('showLastAgent', true) !== false,
		showLastCommits: vscode.workspace.getConfiguration('bgTone').get<boolean>('showLastCommits', true) !== false,
		showActions: vscode.workspace.getConfiguration('bgTone').get<boolean>('showActions', true) !== false,
		palette: getValue<unknown>('palette', undefined),
	};
}

export function repoName(): string {
	return primaryFolder()?.name ?? vscode.workspace.name ?? 'workspace';
}

/**
 * Serializes settings writes: concurrent `update()` calls against the same settings.json
 * can clobber each other, and the settings page may send several changes in quick succession.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Writes `bgTone.<key>` into the `bgTone` section of the repo's pulpfixer.json (undefined removes it), then
 * re-applies the tone. The file is the committed source of truth; the applied colors derived from it land
 * in the workspace settings.
 */
export function updateBgTone(context: vscode.ExtensionContext, key: string, value: unknown): Promise<void> {
	return updateBgToneMany(context, { [key]: value });
}

function updateBgToneMany(context: vscode.ExtensionContext, changes: Record<string, unknown>): Promise<void> {
	const run = async () => {
		const hadLegacy = hasLegacyValues();
		const error = writeRepoValues(changes);
		if (error) {
			throw new Error(error);
		}
		if (hadLegacy) {
			await clearLegacyValues();
		}
		await applyTone(context);
	};
	writeQueue = writeQueue.then(run).catch(err => {
		console.error(`[bgTone] failed to write ${Object.keys(changes).join(', ')}`, err);
		void vscode.window.showErrorMessage(`Background Tone: could not save "${Object.keys(changes).join(', ')}". ${String(err?.message ?? err)}`);
	});
	return writeQueue;
}

/** Removes the whole `bgTone` section from pulpfixer.json (and any legacy workspace values) so the repo returns to defaults. */
export async function resetBgTone(context: vscode.ExtensionContext): Promise<void> {
	await updateBgToneMany(context, Object.fromEntries(REPO_KEYS.map(key => [key, undefined])));
}
