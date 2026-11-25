import * as vscode from 'vscode';
import { LogoService, droppedLogoPath } from './logoService.ts';
import * as path from 'node:path';
import { AgentRun, readChatTitles, readRecentAgentRuns } from './agentRuns.ts';
import type { ActionsService } from './actionsService.ts';
import { CardActions, CardAgent, CardCache, CardCommit, CardSnapshot, composeSnapshot, escapeAttribute, NO_ACTIONS } from './cardCache.ts';
import { primaryFolder, readConfig, repoName, updateBgTone } from './settings.ts';
import { identityVisible } from './repoConfig.ts';
import { isPfRepo } from './store.ts';
import { VERSIONS_FILE, parseStackVersion } from './stackVersion.ts';
import { NO_VERSIONS, VersionsState } from './versions.ts';
import { VersionsService, hasVersionsFile } from './versionsService.ts';
import * as fs from 'node:fs';
import { runGit } from './git.ts';
import { countChangedFiles } from './gitChanges.ts';
import { LOG_ARGS_FORMAT, parseHashSet, parseRecentCommits } from './gitLog.ts';

/** How often the card re-reads the agent transcripts (cheap: one directory scan, two small reads). */
const AGENT_POLL_MS = 10_000;
/** Chat titles are generated after the first turn and can be renamed, so re-check them now and then. */
const TITLE_TTL_MS = 60_000;

export const IDENTITY_CARD_VIEW = 'bgTone.identityCard';
export const IDENTITY_SCM_CARD_VIEW = 'bgTone.identityCardScm';
export const IDENTITY_ITEM_VIEW = 'bgTone.identityItem';
export const VERSIONS_SCM_VIEW = 'bgTone.versionsScm';

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

/** Decides which identity views should exist, and keeps their `when` context keys in sync. */
export async function updateIdentityContext(logos: LogoService): Promise<void> {
	const config = readConfig();
	const hasLogo = logos.logo !== undefined;
	const hasColor = config.color !== '' && config.enabled;
	const hasFolder = !!vscode.workspace.workspaceFolders?.length;
	// A repo set up with `pf rp` has a pulpfixer.json: show the card even before a logo or color is chosen.
	const hasIdentity = identityVisible({ hasFolder, hasLogo, hasColor, pfRepo: isPfRepo() });
	await vscode.commands.executeCommand(
		'setContext',
		'bgTone.cardVisible',
		hasIdentity && config.logoLocations.includes('identityCard'),
	);
	await vscode.commands.executeCommand(
		'setContext',
		'bgTone.scmCardVisible',
		hasIdentity && config.logoLocations.includes('scmCard'),
	);
	await vscode.commands.executeCommand(
		'setContext',
		'bgTone.versionsViewVisible',
		hasFolder && config.versions === 'view' && hasVersionsFile(),
	);
	await vscode.commands.executeCommand(
		'setContext',
		'bgTone.itemVisible',
		hasFolder && config.logoLocations.includes('explorerItem') && hasLogo,
	);
}

/** The stack version from the repo's versions.json (read fresh: it is a tiny local file); empty without one. */
function stackVersion(): string {
	const folder = primaryFolder();
	if (folder?.uri.scheme !== 'file') {
		return '';
	}
	try {
		return parseStackVersion(fs.readFileSync(path.join(folder.uri.fsPath, VERSIONS_FILE), 'utf8')) ?? '';
	} catch {
		return '';
	}
}

/** Files with uncommitted changes in the primary folder (`git status`); null without a local git repo or git. */
async function uncommittedFiles(): Promise<number | null> {
	const folder = primaryFolder();
	if (folder?.uri.scheme !== 'file') {
		return null;
	}
	const result = await runGit(folder.uri.fsPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 5000);
	return result.ok ? countChangedFiles(result.stdout) : null;
}

/** The last 3 commits of the primary folder (`git log`); empty without a local git repo, git, or any commit. */
async function recentCommits(): Promise<CardCommit[]> {
	const folder = primaryFolder();
	if (folder?.uri.scheme !== 'file') {
		return [];
	}
	const cwd = folder.uri.fsPath;
	const [log, upstream] = await Promise.all([
		runGit(cwd, ['log', '-n', '3', LOG_ARGS_FORMAT], 5000),
		runGit(cwd, ['rev-list', '@{upstream}..HEAD'], 5000),
	]);
	if (!log.ok) {
		return [];
	}
	// Local-only commits: those past the upstream branch, else those no remote branch has (no remote at all: all
	// of them). `pushed` is left out only when git could not answer.
	const local = upstream.ok ? upstream : await runGit(cwd, ['rev-list', 'HEAD', '--not', '--remotes'], 5000);
	return parseRecentCommits(log.stdout, 3, local.ok ? parseHashSet(local.stdout) : undefined);
}

/**
 * Commits every uncommitted file: asks for a message first (the dialog is the confirmation), then
 * `git add -A` and `git commit`. Hooks run as usual (no `--no-verify`); a failure is shown, nothing is retried.
 */
async function commitAll(): Promise<boolean> {
	const folder = primaryFolder();
	if (folder?.uri.scheme !== 'file') {
		return false;
	}
	if (!vscode.workspace.isTrusted) {
		void vscode.window.showWarningMessage('Background Tone: trust this workspace to commit from the card.');
		return false;
	}
	const cwd = folder.uri.fsPath;
	const count = await uncommittedFiles();
	if (!count) {
		void vscode.window.showInformationMessage('Background Tone: nothing to commit.');
		return false;
	}
	const noun = count === 1 ? '1 file' : `${count} files`;
	const message = await vscode.window.showInputBox({
		title: `Commit ${noun}`,
		prompt: `Stages everything (git add -A, untracked files included) and commits it. Commit message:`,
		value: `Update ${noun}`,
		validateInput: value => (value.trim() === '' ? 'A commit message is required.' : undefined),
	});
	if (message === undefined) {
		return false;
	}
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Committing ${noun}...` }, async () => {
		const add = await runGit(cwd, ['add', '-A'], 30_000);
		if (!add.ok) {
			void vscode.window.showErrorMessage(`Background Tone: git add failed: ${add.stderr.trim().split('\n')[0]}`);
			return false;
		}
		const commit = await runGit(cwd, ['commit', '-m', message.trim()], 120_000);
		if (!commit.ok) {
			const detail = (commit.stdout + '\n' + commit.stderr).trim().split('\n').filter(Boolean).slice(-3).join(' ');
			void vscode.window.showErrorMessage(`Background Tone: git commit failed: ${detail}`.slice(0, 300));
			return true; // files may be staged now: redraw
		}
		void vscode.window.showInformationMessage(`Background Tone: committed ${noun}.`);
		return true;
	});
}

/** What the list under the card shows: the Explorer card lists agent chats, the Source Control card the last commits. */
export type CardList = 'chats' | 'commits';

/** The "Repo Identity" card: the repo logo, name and tone color. One instance per view (Explorer, Source Control). */
export class IdentityCardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private generation = 0;
	private soonTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly titleCache = new Map<string, { title: string; at: number }>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logos: LogoService,
		private readonly actions: ActionsService,
		private readonly versions: VersionsService,
		private readonly cache: CardCache,
		private readonly list: CardList = 'chats',
	) {
		this.disposables.push(this.actions.onDidChange(() => this.refresh()));
		// The uncommitted-files count follows edits (the poll covers commits, checkouts and other tools).
		const soon = () => this.refreshSoon();
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(soon),
			vscode.workspace.onDidCreateFiles(soon),
			vscode.workspace.onDidDeleteFiles(soon),
			vscode.workspace.onDidRenameFiles(soon),
			{ dispose: () => clearTimeout(this.soonTimer) },
		);
		// `pnpm ver bump` rewrites versions.json: redraw the version beside the name (and a commit resets "stack bumped").
		this.disposables.push(watchVersions(() => this.refresh()));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'media'),
				...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri),
			],
		};
		view.title = repoName();
		// The page paints this right away; the fresh state replaces it when it is ready.
		view.webview.html = this.html(view.webview, this.shown(this.snapshot(undefined)));
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			if (view.visible) {
				this.refresh();
			}
		}, AGENT_POLL_MS);
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.refresh();
			}
		}, null, this.disposables);
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
				this.stopPolling();
			}
		}, null, this.disposables);
		view.webview.onDidReceiveMessage((m: { type?: string; id?: unknown; target?: unknown; part?: unknown; on?: unknown; items?: unknown }) => {
			if (m?.type === 'ready') {
				this.refresh();
				void this.actions.refresh();
			} else if (m?.type === 'run' && typeof m.id === 'string') {
				// Only an id comes from the page; what runs is looked up in pf's own list.
				this.actions.runAction(m.id);
			} else if (m?.type === 'commit') {
				// No payload is trusted: the count, the message prompt and the git calls are all the extension's own.
				void commitAll().then(changed => changed && this.refresh());
			} else if (m?.type === 'bump') {
				// Only a target and a part come from the page; both are checked against versions.json.
				const { target, part } = m as { target?: unknown; part?: unknown };
				void this.versions.bump(target, part).then(() => this.refresh());
			} else if (m?.type === 'feature') {
				// A package path and a yes or no; both are checked against versions.json.
				void this.versions.setFeatured(m.target, m.on).then(() => this.refresh());
			} else if (m?.type === 'commitVersions') {
				// No payload: the files, the message and the git calls are all the extension's own.
				void this.versions.commit().then(() => this.refresh());
			} else if (m?.type === 'editActions') {
				void vscode.commands.executeCommand('bgTone.openSettings', 'actions');
			} else if (m?.type === 'dropLogo') {
				// Only candidate paths come from the page; the logo must be an image file inside this repo.
				const rel = droppedLogoPath(m.items);
				if (rel) {
					void updateBgTone(this.context, 'logo', rel);
				}
			}
		}, null, this.disposables);
	}

	refresh(): void {
		void this.render();
	}

	/** A burst of saves or file changes becomes one refresh. */
	private refreshSoon(): void {
		clearTimeout(this.soonTimer);
		this.soonTimer = setTimeout(() => {
			if (this.view?.visible) {
				this.refresh();
			}
		}, 1000);
	}

	private async render(): Promise<void> {
		const view = this.view;
		if (!view) {
			return;
		}
		const generation = ++this.generation;
		// The header stays readable while the card is collapsed (the logo itself needs the body).
		view.title = repoName();
		view.description = undefined;
		const config = readConfig();
		const [runs, commits, changes, versions] = await Promise.all([
			this.list === 'chats' && config.showLastAgent ? this.recentAgents() : Promise.resolve(undefined),
			this.list === 'commits' && config.showLastCommits ? recentCommits() : Promise.resolve(undefined),
			uncommittedFiles(),
			this.showsVersions() ? this.versions.state() : Promise.resolve(undefined),
		]);
		if (generation !== this.generation || this.view !== view) {
			return; // a newer refresh superseded this one, or the view went away
		}
		const snapshot = this.snapshot(runs?.map(({ title, status, updatedAt }) => ({ title, status, updatedAt })), commits, changes, versions);
		if (this.logos.loaded && this.actions.status.type !== 'loading') {
			this.cache.set(snapshot);
		}
		void view.webview.postMessage({ type: 'state', state: webviewState(view.webview, this.shown(snapshot)) });
	}

	/** The card from what is known now, with the cached values for the parts that have not loaded yet. */
	private snapshot(agents: CardAgent[] | undefined, commits?: CardCommit[], changes?: number | null, versions?: VersionsState): CardSnapshot {
		const config = readConfig();
		const logo = this.logos.logo;
		return composeSnapshot(
			{
				name: repoName(),
				version: stackVersion(),
				changes,
				color: config.enabled && /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : '',
				logo: this.logos.loaded ? (logo ? { uri: logo.uri.toString(), mtime: logo.mtime } : null) : undefined,
				// Only this card's own list is loaded; the other one stays as cached (and is never drawn here).
				agents: this.list === 'chats' && !config.showLastAgent ? [] : agents,
				commits: this.list === 'commits' && !config.showLastCommits ? [] : commits,
				versions,
				actions: !config.showActions ? NO_ACTIONS : this.actions.status.type === 'loading' ? undefined : this.actionsState(),
			},
			this.cache.snapshot,
		);
	}

	/** The snapshot as this card draws it: the list of the other kind is dropped. */
	private shown(snapshot: CardSnapshot): CardSnapshot {
		return this.list === 'chats'
			? { ...snapshot, commits: [], versions: NO_VERSIONS }
			: { ...snapshot, agents: [], versions: this.showsVersions() ? snapshot.versions : NO_VERSIONS };
	}

	/** Only the Source Control card has the versions list, and only when the setting puts it in the card. */
	private showsVersions(): boolean {
		return this.list === 'commits' && readConfig().versions === 'card';
	}

	/** What the card draws for the actions row: the featured buttons, whether to offer editing, and a hint when pf is the problem. */
	private actionsState(): CardActions {
		const status = this.actions.status;
		const hint =
			status.type === 'no-pf'
				? 'Install pf to get repo action buttons.'
				: status.type === 'old-pf'
					? 'Update pf (pf update) to get repo action buttons.'
					: status.type === 'error'
						? `Repo actions failed: ${status.reason}`.slice(0, 140)
						: '';
		return {
			buttons: this.actions.featured.map(({ id, label, icon }) => ({ id, label, icon })),
			canEdit: status.type === 'ready' && this.actions.actions.length > 0,
			hint,
		};
	}

	/** Recent agent chats, labelled with the tab title Cursor shows (first request as fallback). */
	private async recentAgents(): Promise<AgentRun[]> {
		const folder = primaryFolder();
		// Transcripts live on the local disk; remote/virtual workspaces have no usable path.
		if (folder?.uri.scheme !== 'file') {
			return [];
		}
		const runs = readRecentAgentRuns(folder.uri.fsPath, { limit: 3 });
		const now = Date.now();
		const stale = runs.filter(r => {
			const cached = this.titleCache.get(r.id);
			return !cached || now - cached.at > TITLE_TTL_MS;
		});
		if (stale.length > 0) {
			// Cursor keeps its global state next to this extension's own global storage folder.
			const db = path.join(path.dirname(this.context.globalStorageUri.fsPath), 'state.vscdb');
			const titles = await readChatTitles(db, stale.map(r => r.id));
			for (const run of stale) {
				this.titleCache.set(run.id, { title: titles.get(run.id) ?? '', at: now });
			}
		}
		return runs.map(run => ({ ...run, title: this.titleCache.get(run.id)?.title || run.title }));
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	private html(webview: vscode.Webview, initial: CardSnapshot): string {
		return pageHtml(
			webview,
			this.context.extensionUri,
			['codicon.css', 'identity.css', 'versions.css'],
			['versions-list.js', 'identity.js'],
			JSON.stringify(webviewState(webview, initial)),
		);
	}

	dispose(): void {
		this.stopPolling();
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}
}

/** The message the page renders. `at` lets it choose between the state in its HTML and the one it saved itself. */
function webviewState(webview: vscode.Webview, snapshot: CardSnapshot) {
	const { logo, ...rest } = snapshot;
	const logoSrc = logo ? webview.asWebviewUri(vscode.Uri.parse(logo.uri)).with({ query: `v=${logo.mtime}` }).toString() : '';
	return { ...rest, logoSrc, at: Date.now() };
}

/** The page of a webview: the stylesheets and scripts come from `media/`, the first state is in a data attribute. */
function pageHtml(webview: vscode.Webview, extensionUri: vscode.Uri, styles: string[], scripts: string[], stateJson: string): string {
	const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
	const n = nonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${styles.map(file => `<link rel="stylesheet" href="${media(file)}">`).join('\n')}
</head>
<body>
<div id="card" data-state="${escapeAttribute(stateJson)}"></div>
${scripts.map(file => `<script nonce="${n}" src="${media(file)}"></script>`).join('\n')}
</body>
</html>`;
}

/** Redraw triggers for the versions: `versions.json` itself and the git log of HEAD (a commit resets "stack bumped"). */
function watchVersions(onChange: () => void): vscode.Disposable {
	const folder = primaryFolder();
	if (!folder) {
		return { dispose: () => undefined };
	}
	const watchers = [VERSIONS_FILE, '.git/logs/HEAD'].map(pattern => {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
		watcher.onDidChange(onChange);
		watcher.onDidCreate(onChange);
		watcher.onDidDelete(onChange);
		return watcher;
	});
	return { dispose: () => watchers.forEach(w => w.dispose()) };
}

/** The "Versions" view of Source Control (`bgTone.versions` = `view`): the stack and package versions with `[+]` bump buttons. */
export class VersionsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private generation = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly versions: VersionsService,
		/** Called when versions.json or the git log changes (the view exists only while versions.json does). */
		onFilesChanged: () => void,
	) {
		this.disposables.push(
			watchVersions(() => {
				this.refresh();
				onFilesChanged();
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
		view.webview.html = pageHtml(view.webview, this.context.extensionUri, ['codicon.css', 'versions.css'], ['versions-list.js', 'versions.js'], JSON.stringify({ versions: NO_VERSIONS }));
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			if (view.visible) {
				this.refresh();
			}
		}, AGENT_POLL_MS);
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.refresh();
			}
		}, null, this.disposables);
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
				this.stopPolling();
			}
		}, null, this.disposables);
		view.webview.onDidReceiveMessage((m: { type?: string; target?: unknown; part?: unknown; on?: unknown }) => {
			if (m?.type === 'ready') {
				this.refresh();
			} else if (m?.type === 'bump') {
				// Only a target and a part come from the page; both are checked against versions.json.
				void this.versions.bump(m.target, m.part).then(() => this.refresh());
			} else if (m?.type === 'feature') {
				void this.versions.setFeatured(m.target, m.on).then(() => this.refresh());
			} else if (m?.type === 'commitVersions') {
				void this.versions.commit().then(() => this.refresh());
			}
		}, null, this.disposables);
	}

	refresh(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const view = this.view;
		if (!view) {
			return;
		}
		const generation = ++this.generation;
		const state = await this.versions.state();
		if (generation !== this.generation || this.view !== view) {
			return;
		}
		void view.webview.postMessage({ type: 'state', state: { versions: state } });
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	dispose(): void {
		this.stopPolling();
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}
}

/** A one-item Explorer tree whose icon is the repo logo (small, but always in view). */
export class IdentityItemProvider implements vscode.TreeDataProvider<'repo'> {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly logos: LogoService) {}

	refresh(): void {
		this.emitter.fire();
	}

	getTreeItem(): vscode.TreeItem {
		const config = readConfig();
		const logo = this.logos.logo;
		const item = new vscode.TreeItem(repoName(), vscode.TreeItemCollapsibleState.None);
		item.description = config.enabled && config.color ? config.color : undefined;
		item.tooltip = 'Open repo settings';
		item.iconPath = logo?.uri;
		item.command = { command: 'bgTone.openSettings', title: 'Open Repo Settings' };
		return item;
	}

	getChildren(element?: 'repo'): Array<'repo'> {
		return element ? [] : ['repo'];
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
