import * as vscode from 'vscode';
import { LogoService } from './logoService.ts';
import * as path from 'node:path';
import { AgentRun, readChatTitles, readRecentAgentRuns } from './agentRuns.ts';
import type { ActionsService } from './actionsService.ts';
import { CardActions, CardAgent, CardCache, CardSnapshot, composeSnapshot, escapeAttribute, NO_ACTIONS } from './cardCache.ts';
import { primaryFolder, readConfig, repoName } from './settings.ts';
import { identityVisible } from './repoConfig.ts';
import { isPfRepo } from './store.ts';
import { VERSIONS_FILE, parseStackVersion } from './stackVersion.ts';
import * as fs from 'node:fs';

/** How often the card re-reads the agent transcripts (cheap: one directory scan, two small reads). */
const AGENT_POLL_MS = 10_000;
/** Chat titles are generated after the first turn and can be renamed, so re-check them now and then. */
const TITLE_TTL_MS = 60_000;

export const IDENTITY_CARD_VIEW = 'bgTone.identityCard';
export const IDENTITY_SCM_CARD_VIEW = 'bgTone.identityCardScm';
export const IDENTITY_ITEM_VIEW = 'bgTone.identityItem';

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

/** The "Repo Identity" card: the repo logo, name and tone color. One instance per view (Explorer, Source Control). */
export class IdentityCardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private generation = 0;
	private readonly titleCache = new Map<string, { title: string; at: number }>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logos: LogoService,
		private readonly actions: ActionsService,
		private readonly cache: CardCache,
	) {
		this.disposables.push(this.actions.onDidChange(() => this.refresh()));
		// `pnpm ver bump` rewrites versions.json: redraw the version beside the name.
		const folder = primaryFolder();
		if (folder) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, VERSIONS_FILE));
			watcher.onDidChange(() => this.refresh());
			watcher.onDidCreate(() => this.refresh());
			watcher.onDidDelete(() => this.refresh());
			this.disposables.push(watcher);
		}
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
		view.webview.html = this.html(view.webview, this.snapshot(undefined));
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
		view.webview.onDidReceiveMessage((m: { type?: string; id?: unknown }) => {
			if (m?.type === 'ready') {
				this.refresh();
				void this.actions.refresh();
			} else if (m?.type === 'run' && typeof m.id === 'string') {
				// Only an id comes from the page; what runs is looked up in pf's own list.
				this.actions.runAction(m.id);
			} else if (m?.type === 'editActions') {
				void vscode.commands.executeCommand('bgTone.openSettings', 'actions');
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
		// The header stays readable while the card is collapsed (the logo itself needs the body).
		view.title = repoName();
		view.description = undefined;
		const runs = readConfig().showLastAgent ? await this.recentAgents() : [];
		if (generation !== this.generation || this.view !== view) {
			return; // a newer refresh superseded this one, or the view went away
		}
		const snapshot = this.snapshot(runs.map(({ title, status, updatedAt }) => ({ title, status, updatedAt })));
		if (this.logos.loaded && this.actions.status.type !== 'loading') {
			this.cache.set(snapshot);
		}
		void view.webview.postMessage({ type: 'state', state: webviewState(view.webview, snapshot) });
	}

	/** The card from what is known now, with the cached values for the parts that have not loaded yet. */
	private snapshot(agents: CardAgent[] | undefined): CardSnapshot {
		const config = readConfig();
		const logo = this.logos.logo;
		return composeSnapshot(
			{
				name: repoName(),
				version: stackVersion(),
				color: config.enabled && /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : '',
				logo: this.logos.loaded ? (logo ? { uri: logo.uri.toString(), mtime: logo.mtime } : null) : undefined,
				agents: config.showLastAgent ? agents : [],
				actions: !config.showActions ? NO_ACTIONS : this.actions.status.type === 'loading' ? undefined : this.actionsState(),
			},
			this.cache.snapshot,
		);
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
		const media = (file: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
		const n = nonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('codicon.css')}">
<link rel="stylesheet" href="${media('identity.css')}">
</head>
<body>
<div id="card" data-state="${escapeAttribute(JSON.stringify(webviewState(webview, initial)))}"></div>
<script nonce="${n}" src="${media('identity.js')}"></script>
</body>
</html>`;
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
