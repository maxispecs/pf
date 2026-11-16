import * as vscode from 'vscode';
import { LogoService, webviewLogoSrc } from './logoService.ts';
import * as path from 'node:path';
import { AgentRun, readChatTitles, readRecentAgentRuns } from './agentRuns.ts';
import type { ActionsService } from './actionsService.ts';
import { primaryFolder, readConfig, repoName } from './settings.ts';

/** How often the card re-reads the agent transcripts (cheap: one directory scan, two small reads). */
const AGENT_POLL_MS = 10_000;
/** Chat titles are generated after the first turn and can be renamed, so re-check them now and then. */
const TITLE_TTL_MS = 60_000;

export const IDENTITY_CARD_VIEW = 'bgTone.identityCard';
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
	await vscode.commands.executeCommand(
		'setContext',
		'bgTone.cardVisible',
		hasFolder && config.logoLocations.includes('identityCard') && (hasLogo || hasColor),
	);
	await vscode.commands.executeCommand(
		'setContext',
		'bgTone.itemVisible',
		hasFolder && config.logoLocations.includes('explorerItem') && hasLogo,
	);
}

/** The "Repo Identity" card: the repo logo, name and tone color at the top of the Explorer. */
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
	) {
		this.disposables.push(this.actions.onDidChange(() => this.refresh()));
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
		view.webview.html = this.html(view.webview);
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
		const config = readConfig();
		const logo = this.logos.logo;
		const color = config.enabled && /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : '';
		// The header stays readable while the card is collapsed (the logo itself needs the body).
		view.title = repoName();
		view.description = undefined;
		const agents = config.showLastAgent ? await this.recentAgents() : [];
		if (generation !== this.generation || this.view !== view) {
			return; // a newer refresh superseded this one, or the view went away
		}
		void view.webview.postMessage({
			type: 'state',
			state: {
				name: repoName(),
				color,
				logoSrc: logo ? webviewLogoSrc(view.webview, logo) : '',
				agents: agents.map(({ title, status, updatedAt }) => ({ title, status, updatedAt })),
				actions: config.showActions ? this.actionsState() : { buttons: [], canEdit: false, hint: '' },
			},
		});
	}

	/** What the card draws for the actions row: the featured buttons, whether to offer editing, and a hint when pf is the problem. */
	private actionsState(): { buttons: Array<{ id: string; label: string; icon: string }>; canEdit: boolean; hint: string } {
		const status = this.actions.status;
		const hint =
			status.type === 'no-pf'
				? 'Install pf to get repo action buttons.'
				: status.type === 'old-pf'
					? 'Update pf (pf update) to get repo action buttons.'
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

	private html(webview: vscode.Webview): string {
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
<div id="card"></div>
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
