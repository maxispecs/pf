import * as vscode from 'vscode';
import { ALL_SURFACES, colorFromName, defaultBaseFor } from './color.ts';
import { themeKindName } from './apply.ts';
import { mergePalette, normalizeHex, parsePalette } from './presets.ts';
import { LogoService, pickLogoPath, webviewLogoSrc } from './logoService.ts';
import { readConfig, repoName, resetBgTone, updateBgTone } from './settings.ts';
import { statusNotice } from './actions.ts';
import type { ActionsService } from './actionsService.ts';
import { configFilePath, onDidChangeRepoConfig } from './store.ts';
import { SURFACE_LABELS, computePreview, isWritableKey, sanitizeSetting } from './settingsModel.ts';
import type { PreviewInput } from './settingsModel.ts';

export const SETTINGS_PANEL_TYPE = 'bgTone.settings';

type InboundMessage =
	| { type: 'ready' }
	| { type: 'set'; key: unknown; value: unknown }
	| { type: 'preview'; input: Partial<PreviewInput> }
	| { type: 'pickLogo' }
	| { type: 'clearLogo' }
	| { type: 'addPalette'; color: unknown; label: unknown }
	| { type: 'removePalette'; color: unknown }
	| { type: 'randomize' }
	| { type: 'clearTone' }
	| { type: 'reset' }
	| { type: 'setFeatured'; id: unknown; featured: unknown }
	| { type: 'refreshActions' }
	| { type: 'openSettingsJson' };

export type SettingsTab = 'tone' | 'logo' | 'actions';

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

/** The "Repo Settings" page: a webview in an editor tab, with the repo logo as the tab icon. */
export class SettingsPanel implements vscode.Disposable {
	private static instance: SettingsPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	/** A tab the page should switch to with its next state (set before the page has loaded, too). */
	private requestedTab: SettingsTab | undefined;
	private ready = false;

	static show(context: vscode.ExtensionContext, logos: LogoService, actions: ActionsService, tab?: SettingsTab): void {
		if (SettingsPanel.instance) {
			SettingsPanel.instance.panel.reveal(undefined, false);
			if (tab) {
				SettingsPanel.instance.showTab(tab);
			}
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			SETTINGS_PANEL_TYPE,
			'Repo Settings',
			vscode.ViewColumn.Active,
			SettingsPanel.options(context),
		);
		SettingsPanel.instance = new SettingsPanel(panel, context, logos, actions);
		if (tab) {
			SettingsPanel.instance.showTab(tab);
		}
	}

	/** Re-attaches a panel restored by VS Code after a reload. */
	static restore(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, logos: LogoService, actions: ActionsService): void {
		if (SettingsPanel.instance) {
			panel.dispose();
			return;
		}
		SettingsPanel.instance = new SettingsPanel(panel, context, logos, actions);
	}

	private static options(context: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
		return {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(context.extensionUri, 'media'),
				...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri),
			],
		};
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly logos: LogoService,
		private readonly actions: ActionsService,
	) {
		panel.webview.options = SettingsPanel.options(context);
		panel.webview.html = this.html();
		this.updateChrome();

		this.disposables.push(
			panel.onDidDispose(() => this.dispose()),
			panel.webview.onDidReceiveMessage((m: InboundMessage) => {
				void this.onMessage(m).catch(err => {
					console.error('[bgTone] settings page message failed', err);
				});
			}),
			onDidChangeRepoConfig(() => this.postState()),
			actions.onDidChange(() => this.postState()),
			vscode.window.onDidChangeActiveColorTheme(() => this.postState()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.postState()),
			logos.onDidChange(() => {
				this.updateChrome();
				this.postState();
			}),
		);
	}

	private html(): string {
		const webview = this.panel.webview;
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
<link rel="stylesheet" href="${media('settings.css')}">
<title>Repo Settings</title>
</head>
<body>
<div id="app"><p class="muted">Loading...</p></div>
<script nonce="${n}" src="${media('settings.js')}"></script>
</body>
</html>`;
	}

	/** Tab title and tab icon (the repo logo when there is one). */
	private updateChrome(): void {
		this.panel.title = `Repo Settings: ${repoName()}`;
		const logo = this.logos.logo;
		this.panel.iconPath = logo?.uri ?? vscode.Uri.joinPath(this.context.extensionUri, 'media', 'logo.svg');
	}

	private state(): unknown {
		const config = readConfig();
		const kind = themeKindName(vscode.window.activeColorTheme.kind);
		const status = this.logos.current;
		let logo: { status: string; relPath: string; src?: string; message?: string };
		if (status.type === 'ok') {
			logo = { status: 'ok', relPath: status.logo.relPath, src: webviewLogoSrc(this.panel.webview, status.logo) };
		} else if (status.type === 'error') {
			logo = { status: 'error', relPath: config.logo, message: status.message };
		} else {
			logo = { status: 'none', relPath: '' };
		}
		return {
			requestTab: this.requestedTab,
			repoName: repoName(),
			hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
			kind,
			config: {
				enabled: config.enabled,
				color: config.color,
				strength: config.strength,
				surfaces: config.surfaces,
				baseColors: config.baseColors,
				accentBorder: config.accentBorder,
				logoLocations: config.logoLocations,
				titleEmoji: config.titleEmoji,
			},
			palette: mergePalette(config.palette),
			surfaceMeta: ALL_SURFACES.map(id => ({ id, ...SURFACE_LABELS[id], defaultBase: defaultBaseFor(kind, id) ?? '#808080' })),
			logo,
			preview: computePreview(config, kind),
			actions: {
				status: this.actions.status.type,
				notice: statusNotice(this.actions.status),
				items: this.actions.actions.map(({ id, label, icon, featured, argv }) => ({
					id,
					label,
					icon,
					featured,
					command: `pf ${argv.join(' ')}`,
				})),
			},
		};
	}

	/** Switches the page to a tab (the Repo Identity card's edit button opens the actions one). */
	showTab(tab: SettingsTab): void {
		this.requestedTab = tab;
		this.postState();
	}

	private postState(): void {
		void this.panel.webview.postMessage({ type: 'state', state: this.state() });
		if (this.ready) {
			this.requestedTab = undefined; // delivered; before the page loads it waits for the first state
		}
	}

	private async onMessage(message: InboundMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.ready = true;
				this.postState();
				return;
			case 'preview': {
				const config = readConfig();
				const input: PreviewInput = { ...config, ...sanitizePreview(message.input) };
				void this.panel.webview.postMessage({
					type: 'preview',
					preview: computePreview(input, themeKindName(vscode.window.activeColorTheme.kind)),
				});
				return;
			}
			case 'set': {
				if (!isWritableKey(message.key)) {
					return;
				}
				const result = sanitizeSetting(message.key, message.value);
				if (!result.ok) {
					void vscode.window.showWarningMessage(`Background Tone: ${result.reason}`);
					this.postState(); // snap the form back to the stored value
					return;
				}
				await updateBgTone(this.context, message.key, result.value);
				this.postState();
				return;
			}
			case 'pickLogo': {
				const rel = await pickLogoPath();
				if (rel) {
					await updateBgTone(this.context, 'logo', rel);
				}
				return;
			}
			case 'clearLogo':
				await updateBgTone(this.context, 'logo', undefined);
				return;
			case 'addPalette': {
				const color = normalizeHex(message.color);
				if (!color) {
					void vscode.window.showWarningMessage('Background Tone: enter a valid hex color first.');
					return;
				}
				const label = typeof message.label === 'string' && message.label.trim() !== '' ? message.label.trim() : color;
				const existing = parsePalette(workspacePalette()).filter(p => p.color !== color);
				await updateBgTone(this.context, 'palette', [...existing, { label, color }].map(({ label, color }) => ({ label, color })));
				return;
			}
			case 'removePalette': {
				const color = normalizeHex(message.color);
				const remaining = parsePalette(workspacePalette()).filter(p => p.color !== color);
				await updateBgTone(
					this.context,
					'palette',
					remaining.length > 0 ? remaining.map(({ label, color }) => ({ label, color })) : undefined,
				);
				return;
			}
			case 'setFeatured': {
				// Only an id and a flag come from the page; pf's own list decides whether the id exists.
				const id = message.id;
				if (typeof id !== 'string' || typeof message.featured !== 'boolean' || !this.actions.actions.some(a => a.id === id)) {
					this.postState();
					return;
				}
				const failure = await this.actions.setFeatured([id], message.featured);
				if (failure) {
					void vscode.window.showErrorMessage(`Background Tone: could not save the featured actions. ${failure}`);
					this.postState(); // snap the checkbox back
				}
				return;
			}
			case 'refreshActions':
				await this.actions.refresh();
				return;
			case 'randomize':
				await updateBgTone(this.context, 'color', colorFromName(repoName()));
				return;
			case 'clearTone':
				await updateBgTone(this.context, 'color', undefined);
				return;
			case 'reset': {
				const answer = await vscode.window.showWarningMessage(
					'Reset all Background Tone settings for this repo?',
					{ modal: true, detail: 'Removes the bgTone section from the pulpfixer.json of this repo. Your logo image file is not touched.' },
					'Reset',
				);
				if (answer === 'Reset') {
					await resetBgTone(this.context);
				}
				return;
			}
			case 'openSettingsJson':
				{
					const file = configFilePath();
					if (file) {
						await vscode.window.showTextDocument(vscode.Uri.file(file));
					} else {
						await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
					}
				}
				return;
		}
	}

	dispose(): void {
		if (SettingsPanel.instance === this) {
			SettingsPanel.instance = undefined;
		}
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
		this.panel.dispose();
	}
}

function workspacePalette(): unknown {
	return readConfig().palette;
}

/** Only accepts well-typed preview overrides; anything else is ignored. */
function sanitizePreview(input: Partial<PreviewInput> | undefined): Partial<PreviewInput> {
	const out: Partial<PreviewInput> = {};
	if (!input || typeof input !== 'object') {
		return out;
	}
	for (const key of ['enabled', 'color', 'strength', 'surfaces', 'baseColors', 'accentBorder'] as const) {
		if (!(key in input)) {
			continue;
		}
		const result = sanitizeSetting(key, (input as Record<string, unknown>)[key]);
		if (!result.ok) {
			continue;
		}
		// `undefined` from the sanitizer means "unset": an empty color or no base overrides.
		(out as Record<string, unknown>)[key] = result.value ?? (key === 'baseColors' ? {} : '');
	}
	return out;
}
