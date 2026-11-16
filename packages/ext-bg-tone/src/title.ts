import * as vscode from 'vscode';
import { buildWindowTitle, isGeneratedTitle } from './logo.ts';
import { hasWorkspace } from './apply.ts';
import { readConfig } from './settings.ts';

/** workspaceState key remembering the window.title we last wrote, so we only remove our own. */
const APPLIED_TITLE_KEY = 'bgTone.appliedTitle';

let queue: Promise<void> = Promise.resolve();

/**
 * Keeps the workspace `window.title` prefixed with `bgTone.titleEmoji` while `windowTitle` is
 * enabled in `bgTone.logoLocations`. A `window.title` the user set themselves in the workspace
 * is never overwritten or removed.
 */
export function applyTitle(context: vscode.ExtensionContext): Promise<void> {
	queue = queue.then(() => doApplyTitle(context)).catch(err => {
		console.error('[bgTone] failed to apply window title', err);
	});
	return queue;
}

async function doApplyTitle(context: vscode.ExtensionContext): Promise<void> {
	if (!hasWorkspace()) {
		return;
	}
	const config = readConfig();
	const windowConfig = vscode.workspace.getConfiguration('window');
	const inspected = windowConfig.inspect<string>('title');
	const current = inspected?.workspaceValue;
	const lastApplied = context.workspaceState.get<string>(APPLIED_TITLE_KEY);

	// Blend onto the user's own title template (global) or VS Code's default, never our value.
	const base = inspected?.globalValue ?? inspected?.defaultValue;
	const desired = config.logoLocations.includes('windowTitle')
		? buildWindowTitle(config.titleEmoji, base)
		: undefined;

	if (desired !== undefined) {
		const owned = current === undefined || current === lastApplied || isGeneratedTitle(current, base);
		if (!owned) {
			return; // the repo already has its own window.title; leave it alone
		}
		if (current !== desired) {
			await windowConfig.update('title', desired, vscode.ConfigurationTarget.Workspace);
		}
		await context.workspaceState.update(APPLIED_TITLE_KEY, desired);
		return;
	}

	if (current !== undefined && (current === lastApplied || isGeneratedTitle(current, base))) {
		await windowConfig.update('title', undefined, vscode.ConfigurationTarget.Workspace);
	}
	await context.workspaceState.update(APPLIED_TITLE_KEY, undefined);
}
