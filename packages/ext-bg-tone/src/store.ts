import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFIG_FILE, LEGACY_CONFIG_FILE, editSection, parseSection, pickConfigFile } from './repoConfig.ts';

/** Keys that live in the repo's pulpfixer.json (`bgTone` section). `showLastAgent` is personal and stays a VS Code setting. */
export const REPO_KEYS = [
	'enabled',
	'color',
	'strength',
	'surfaces',
	'baseColors',
	'accentBorder',
	'logo',
	'logoLocations',
	'titleEmoji',
	'palette',
] as const;

/** The first workspace folder: the "repo" for the config file, logo, name and title. */
export function primaryFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

/** Absolute path of the repo config file, or undefined without a (local) folder. */
export function configFilePath(): string | undefined {
	const folder = primaryFolder();
	if (!folder || folder.uri.scheme !== 'file') {
		return undefined;
	}
	const root = folder.uri.fsPath;
	return path.join(root, pickConfigFile(name => fs.existsSync(path.join(root, name))));
}

function readText(file: string | undefined): string | null {
	if (!file) {
		return null;
	}
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

/** Legacy `bgTone.*` workspace settings (what versions before the pulpfixer.json move wrote). */
function legacyWorkspaceValues(): Record<string, unknown> {
	const config = vscode.workspace.getConfiguration('bgTone');
	const found: Record<string, unknown> = {};
	for (const key of REPO_KEYS) {
		const value = config.inspect<unknown>(key)?.workspaceValue;
		if (value !== undefined) {
			found[key] = value;
		}
	}
	return found;
}

let warnedInvalid: string | undefined;

/**
 * The repo's values: the `bgTone` section of pulpfixer.json when it has one, else the legacy workspace
 * settings (so a repo set up before the move keeps its tone until the first save writes the section).
 */
export function repoValues(): Record<string, unknown> {
	const file = configFilePath();
	const parsed = parseSection(readText(file));
	if (parsed.type === 'section') {
		return parsed.values;
	}
	if (parsed.type === 'invalid' && file && warnedInvalid !== file) {
		warnedInvalid = file;
		void vscode.window.showWarningMessage(`Background Tone: ${path.basename(file)} is ${parsed.reason}, so its bgTone section is ignored. Fix the file; it is never overwritten.`);
	}
	return legacyWorkspaceValues();
}

/** One repo value, falling back to the extension's default for the key (the contributed setting's default). */
export function getValue<T>(key: string, fallback: T): T {
	const values = repoValues();
	if (key in values && values[key] !== undefined) {
		return values[key] as T;
	}
	const inspected = vscode.workspace.getConfiguration('bgTone').inspect<T>(key);
	// A global (user) value still applies when the repo says nothing, like before.
	return (inspected?.globalValue ?? inspected?.defaultValue ?? fallback) as T;
}

const emitter = new vscode.EventEmitter<void>();
/** Fires when the repo config file or the legacy settings change, or the workspace folders do. */
export const onDidChangeRepoConfig = emitter.event;

/** Watches pulpfixer.json (and the legacy pf.json) of the first folder. Create once, in `activate`. */
export function watchRepoConfig(): vscode.Disposable {
	let watcher: vscode.FileSystemWatcher | undefined;
	const rewatch = () => {
		watcher?.dispose();
		watcher = undefined;
		const folder = primaryFolder();
		if (folder) {
			watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `{${CONFIG_FILE},${LEGACY_CONFIG_FILE}}`));
			watcher.onDidChange(() => emitter.fire());
			watcher.onDidCreate(() => emitter.fire());
			watcher.onDidDelete(() => emitter.fire());
		}
	};
	rewatch();
	const subs = [
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			rewatch();
			emitter.fire();
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('bgTone')) {
				emitter.fire();
			}
		}),
	];
	return { dispose: () => [...subs, { dispose: () => watcher?.dispose() }].forEach(d => d.dispose()) };
}

/**
 * Writes `changes` into the `bgTone` section of pulpfixer.json (`undefined` removes a key), creating the
 * file when needed. When the repo still has legacy workspace values, they are moved into the section first.
 * Returns an error message, or undefined on success.
 */
export function writeRepoValues(changes: Record<string, unknown>): string | undefined {
	const file = configFilePath();
	if (!file) {
		return 'open a local folder first';
	}
	const text = readText(file);
	const parsed = parseSection(text);
	const migrated = parsed.type === 'none' ? legacyWorkspaceValues() : {};
	const result = editSection(text, { ...migrated, ...changes });
	if (!result.ok) {
		return `${path.basename(file)} is ${result.reason}; it was not changed`;
	}
	if (result.text === '' && text === null) {
		return undefined;
	}
	try {
		fs.writeFileSync(file, result.text);
	} catch (e) {
		return `could not write ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`;
	}
	return undefined;
}

/** True when the repo still keeps values only in the legacy workspace settings. */
export function hasLegacyValues(): boolean {
	return parseSection(readText(configFilePath())).type === 'none' && Object.keys(legacyWorkspaceValues()).length > 0;
}

/**
 * Removes the legacy `bgTone.*` workspace values. Called once they are in pulpfixer.json, so an emptied
 * section does not make the old values reappear.
 */
export async function clearLegacyValues(): Promise<void> {
	const config = vscode.workspace.getConfiguration('bgTone');
	for (const key of Object.keys(legacyWorkspaceValues())) {
		await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
	}
}
