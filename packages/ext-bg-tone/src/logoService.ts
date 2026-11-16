import * as vscode from 'vscode';
import { LOGO_EXTENSIONS, toRelativeLogoPath, validateLogoPath } from './logo.ts';
import { primaryFolder } from './settings.ts';

/** Larger images are ignored: they would slow down the webviews for no visual gain. */
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export interface ResolvedLogo {
	/** file: (or remote workspace) URI of the image inside the repo. */
	uri: vscode.Uri;
	/** Workspace-relative path as stored in settings. */
	relPath: string;
	/** Modified time, used to cache-bust webview image URLs. */
	mtime: number;
}

export type LogoStatus =
	| { type: 'none' }
	| { type: 'ok'; logo: ResolvedLogo }
	| { type: 'error'; message: string };

async function resolve(rawPath: string): Promise<LogoStatus> {
	if (rawPath.trim() === '') {
		return { type: 'none' };
	}
	const folder = primaryFolder();
	if (!folder) {
		return { type: 'none' };
	}
	const validated = validateLogoPath(rawPath);
	if (!validated.ok) {
		return { type: 'error', message: validated.reason };
	}
	const uri = vscode.Uri.joinPath(folder.uri, ...validated.path.split('/'));
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type & vscode.FileType.Directory) {
			return { type: 'error', message: `"${validated.path}" is a folder, not an image.` };
		}
		if (stat.size > MAX_LOGO_BYTES) {
			return { type: 'error', message: `"${validated.path}" is larger than 5 MB.` };
		}
		return { type: 'ok', logo: { uri, relPath: validated.path, mtime: stat.mtime } };
	} catch {
		return { type: 'error', message: `"${validated.path}" was not found in this repo.` };
	}
}

/**
 * Tracks the repo logo: resolves `bgTone.logo`, validates it, and fires when the setting or the
 * image file itself changes so every view can refresh.
 */
export class LogoService implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	private status: LogoStatus = { type: 'none' };
	private watchedPath = '';
	private watcher: vscode.FileSystemWatcher | undefined;
	private watcherSubs: vscode.Disposable[] = [];
	private generation = 0;

	get current(): LogoStatus {
		return this.status;
	}

	/** The usable logo, if any. */
	get logo(): ResolvedLogo | undefined {
		return this.status.type === 'ok' ? this.status.logo : undefined;
	}

	/** Re-reads `rawPath` (the `bgTone.logo` value) and notifies listeners if anything changed. */
	async refresh(rawPath: string): Promise<void> {
		const generation = ++this.generation;
		const next = await resolve(rawPath);
		if (generation !== this.generation) {
			return; // a newer refresh superseded this one
		}
		this.watch(next.type === 'ok' ? next.logo.relPath : '');
		this.status = next;
		this.emitter.fire();
	}

	private watch(relPath: string): void {
		if (relPath === this.watchedPath) {
			return;
		}
		this.unwatch();
		this.watchedPath = relPath;
		const folder = primaryFolder();
		if (!relPath || !folder) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, relPath));
		const onFileEvent = () => {
			void this.refresh(this.watchedPath);
		};
		this.watcher = watcher;
		this.watcherSubs = [
			watcher.onDidChange(onFileEvent),
			watcher.onDidCreate(onFileEvent),
			watcher.onDidDelete(onFileEvent),
		];
	}

	private unwatch(): void {
		this.watcherSubs.forEach(d => d.dispose());
		this.watcherSubs = [];
		this.watcher?.dispose();
		this.watcher = undefined;
		this.watchedPath = '';
	}

	dispose(): void {
		this.unwatch();
		this.emitter.dispose();
	}
}

/**
 * Lets the user choose an image from inside the repo. Returns the workspace-relative path,
 * or undefined if cancelled or if the chosen file is outside the repo.
 */
export async function pickLogoPath(): Promise<string | undefined> {
	const folder = primaryFolder();
	if (!folder) {
		void vscode.window.showInformationMessage('Background Tone: open a folder or workspace first.');
		return undefined;
	}
	const picked = await vscode.window.showOpenDialog({
		title: 'Choose a repo logo (an image inside this repo)',
		openLabel: 'Use as repo logo',
		defaultUri: folder.uri,
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { Images: LOGO_EXTENSIONS.map(e => e.slice(1)) },
	});
	const file = picked?.[0];
	if (!file) {
		return undefined;
	}
	const rel = toRelativeLogoPath(folder.uri.fsPath, file.fsPath);
	if (!rel) {
		void vscode.window.showWarningMessage(
			`Background Tone: the logo must be an image file inside this repo (${folder.name}). ` +
				'Copy it into the repo first so the reference stays valid for everyone who clones it.',
		);
		return undefined;
	}
	return rel;
}

/** Pretty URL for a webview, with the mtime appended so edits to the file show up. */
export function webviewLogoSrc(webview: vscode.Webview, logo: ResolvedLogo): string {
	return webview.asWebviewUri(logo.uri).with({ query: `v=${logo.mtime}` }).toString();
}
