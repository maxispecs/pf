import * as vscode from 'vscode';
import { OWNED_KEYS, ThemeKindName, ToneSettings, resolveTint } from './color.ts';
import { readConfig } from './settings.ts';

/** workspaceState key remembering the values we last wrote, so we only remove our own values. */
const APPLIED_STATE_KEY = 'bgTone.appliedValues';
/** Pre-0.2 state: a single editor.background value. */
const LEGACY_APPLIED_STATE_KEY = 'bgTone.appliedValue';

type ColorCustomizations = Record<string, unknown>;

export function themeKindName(kind: vscode.ColorThemeKind): ThemeKindName {
	switch (kind) {
		case vscode.ColorThemeKind.Light:
			return 'light';
		case vscode.ColorThemeKind.HighContrast:
			return 'highContrast';
		case vscode.ColorThemeKind.HighContrastLight:
			return 'highContrastLight';
		case vscode.ColorThemeKind.Dark:
		default:
			return 'dark';
	}
}

export function readSettings(): ToneSettings {
	const config = readConfig();
	return {
		enabled: config.enabled,
		color: config.color,
		strength: config.strength,
		surfaces: config.surfaces,
		baseColors: config.baseColors,
		accentBorder: config.accentBorder,
	};
}

/** True when there is a workspace to write settings into. */
export function hasWorkspace(): boolean {
	return !!vscode.workspace.workspaceFolders?.length || !!vscode.workspace.workspaceFile;
}

/** Reads only the workspace-level colorCustomizations (never the merged user value). */
function readWorkspaceCustomizations(): ColorCustomizations {
	const inspected = vscode.workspace
		.getConfiguration('workbench')
		.inspect<ColorCustomizations>('colorCustomizations');
	return { ...(inspected?.workspaceValue ?? {}) };
}

async function writeWorkspaceCustomizations(next: ColorCustomizations): Promise<void> {
	await vscode.workspace
		.getConfiguration('workbench')
		.update(
			'colorCustomizations',
			Object.keys(next).length > 0 ? next : undefined,
			vscode.ConfigurationTarget.Workspace,
		);
}

const warned = new Set<string>();

function warnOnce(message: string): void {
	if (warned.has(message)) {
		return;
	}
	warned.add(message);
	void vscode.window.showWarningMessage(`Background Tone: ${message}`);
}

/**
 * Serializes work so that overlapping triggers (config + theme events) can't race
 * each other while writing settings.json.
 */
let queue: Promise<void> = Promise.resolve();

export function applyTone(context: vscode.ExtensionContext): Promise<void> {
	queue = queue.then(() => doApply(context)).catch(err => {
		console.error('[bgTone] failed to apply tone', err);
	});
	return queue;
}

function readApplied(context: vscode.ExtensionContext): Record<string, string> {
	const applied = { ...(context.workspaceState.get<Record<string, string>>(APPLIED_STATE_KEY) ?? {}) };
	const legacy = context.workspaceState.get<string>(LEGACY_APPLIED_STATE_KEY);
	if (legacy !== undefined && applied['editor.background'] === undefined) {
		applied['editor.background'] = legacy;
	}
	return applied;
}

async function writeApplied(context: vscode.ExtensionContext, applied: Record<string, string>): Promise<void> {
	await context.workspaceState.update(
		APPLIED_STATE_KEY,
		Object.keys(applied).length > 0 ? applied : undefined,
	);
	await context.workspaceState.update(LEGACY_APPLIED_STATE_KEY, undefined);
}

async function doApply(context: vscode.ExtensionContext): Promise<void> {
	if (!hasWorkspace()) {
		return;
	}

	const kind = themeKindName(vscode.window.activeColorTheme.kind);
	const result = resolveTint(readSettings(), kind);
	if (result.type === 'invalid') {
		warnOnce(result.message);
		return;
	}

	const desired = result.type === 'tint' ? result.values : {};
	const customizations = readWorkspaceCustomizations();
	const lastApplied = readApplied(context);
	let changed = false;

	for (const key of OWNED_KEYS) {
		const want = desired[key];
		const current = customizations[key];
		if (want !== undefined) {
			if (current !== want) {
				customizations[key] = want;
				changed = true;
			}
		} else if (current !== undefined && lastApplied[key] !== undefined && current === lastApplied[key]) {
			// Only remove values that we put there ourselves.
			delete customizations[key];
			changed = true;
		}
	}

	if (changed) {
		await writeWorkspaceCustomizations(customizations);
	}
	await writeApplied(context, desired);
}
