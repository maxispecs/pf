import * as vscode from 'vscode';
import { applyTone, hasWorkspace } from './apply.ts';
import { colorFromName, parseHex } from './color.ts';
import { mergePalette } from './presets.ts';
import { LogoService, pickLogoPath } from './logoService.ts';
import { readConfig, updateBgTone } from './settings.ts';
import { onDidChangeRepoConfig, watchRepoConfig } from './store.ts';
import { SettingsPanel, SETTINGS_PANEL_TYPE } from './settingsPanel.ts';
import type { SettingsTab } from './settingsPanel.ts';
import {
	IDENTITY_CARD_VIEW,
	IDENTITY_ITEM_VIEW,
	IDENTITY_SCM_CARD_VIEW,
	IdentityCardProvider,
	IdentityItemProvider,
	VERSIONS_SCM_VIEW,
	VersionsViewProvider,
	updateIdentityContext,
} from './identityView.ts';
import { applyTitle } from './title.ts';
import { ActionsService } from './actionsService.ts';
import { diffFeatured } from './actions.ts';
import { CardCache } from './cardCache.ts';
import { VersionsService } from './versionsService.ts';
import { manageCategories } from './categoriesUi.ts';

const NO_COLOR_LABEL = 'No color';
const CUSTOM_LABEL = 'Custom hex color...';
const SETTINGS_LABEL = 'Open full repo settings...';

export function activate(context: vscode.ExtensionContext): void {
	const logos = new LogoService();
	const actions = new ActionsService();
	const cardCache = new CardCache(context.workspaceState);
	const versions = new VersionsService(actions);
	const card = new IdentityCardProvider(context, logos, actions, versions, cardCache, 'chats');
	const scmCard = new IdentityCardProvider(context, logos, actions, versions, cardCache, 'commits');
	const versionsView = new VersionsViewProvider(context, versions, () => void updateIdentityContext(logos));
	const item = new IdentityItemProvider(logos);

	const reapply = () => {
		void applyTone(context);
		void applyTitle(context);
	};

	// Always-visible shortcut (bottom left) that opens the color picker.
	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	statusItem.command = 'bgTone.setColor';
	const refreshStatus = () => {
		const color = readConfig().color;
		statusItem.text = color ? `$(symbol-color) ${color}` : '$(symbol-color) Tone';
		// Hover menu: command links are only honored for a trusted MarkdownString that lists them.
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.isTrusted = { enabledCommands: ['bgTone.setColor', 'bgTone.openSettings', 'bgTone.pickLogo', 'bgTone.clear'] };
		tooltip.supportThemeIcons = true;
		tooltip.appendMarkdown('**Background Tone**\n\n');
		tooltip.appendMarkdown('[$(settings-gear) Open full settings](command:bgTone.openSettings)\n\n');
		tooltip.appendMarkdown('[$(symbol-color) Pick color](command:bgTone.setColor)\n\n');
		tooltip.appendMarkdown('[$(file-media) Choose repo logo](command:bgTone.pickLogo)\n\n');
		tooltip.appendMarkdown('[$(clear-all) Clear tone](command:bgTone.clear)');
		statusItem.tooltip = tooltip;
	};
	refreshStatus();
	statusItem.show();

	// Views read the settings, so they refresh whenever the logo state is recomputed.
	const refreshViews = () => {
		void updateIdentityContext(logos);
		card.refresh();
		scmCard.refresh();
		versionsView.refresh();
		item.refresh();
	};
	const refreshLogo = () => {
		void logos.refresh(readConfig().logo);
	};

	context.subscriptions.push(
		logos,
		actions,
		card,
		scmCard,
		versionsView,
		item,
		statusItem,
		logos.onDidChange(refreshViews),

		// Only react to our own settings: the repo's pulpfixer.json (and the legacy `bgTone.*` settings).
		// Our writes go to `workbench.colorCustomizations` and `window.title`, which are deliberately not
		// listened to, so applying can never retrigger itself.
		watchRepoConfig(),
		onDidChangeRepoConfig(() => {
			refreshStatus();
			reapply();
			refreshLogo();
			// pulpfixer.json also holds the commands and `actions` the buttons come from.
			actions.refreshSoon();
			// `bgTone.versions` decides whether the Versions view exists and whether the card has the list.
			void updateIdentityContext(logos);
			card.refresh();
			scmCard.refresh();
			versionsView.refresh();
		}),
		vscode.window.onDidChangeActiveColorTheme(() => void applyTone(context)),

		// Kept alive while hidden, so switching between Explorer and Source Control does not rebuild the card.
		vscode.window.registerWebviewViewProvider(IDENTITY_CARD_VIEW, card, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewViewProvider(IDENTITY_SCM_CARD_VIEW, scmCard, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewViewProvider(VERSIONS_SCM_VIEW, versionsView, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerTreeDataProvider(IDENTITY_ITEM_VIEW, item),
		vscode.window.registerWebviewPanelSerializer(SETTINGS_PANEL_TYPE, {
			async deserializeWebviewPanel(panel) {
				SettingsPanel.restore(panel, context, logos, actions);
			},
		}),

		vscode.commands.registerCommand('bgTone.setColor', () => setColor(context)),
		vscode.commands.registerCommand('bgTone.openSettings', (tab?: unknown) => openSettings(context, logos, actions, tab === 'actions' ? 'actions' : undefined)),
		vscode.commands.registerCommand('bgTone.pickLogo', () => pickLogo(context)),
		vscode.commands.registerCommand('bgTone.clearLogo', () => clearLogo(context)),
		vscode.commands.registerCommand('bgTone.randomize', () => randomize(context)),
		vscode.commands.registerCommand('bgTone.clear', () => clear(context)),
		vscode.commands.registerCommand('bgTone.editActions', () => editActions(actions)),
		vscode.commands.registerCommand('bgTone.manageCategories', async () => {
			await manageCategories(versions);
			card.refresh();
			scmCard.refresh();
			versionsView.refresh();
		}),
	);

	reapply();
	refreshLogo();
	void actions.refresh();
}

export function deactivate(): void {
	// Nothing to clean up: the applied tone intentionally stays in workspace settings.
}

function ensureWorkspace(): boolean {
	if (!hasWorkspace()) {
		void vscode.window.showInformationMessage('Background Tone: open a folder or workspace first.');
		return false;
	}
	return true;
}

function openSettings(context: vscode.ExtensionContext, logos: LogoService, actions: ActionsService, tab?: SettingsTab): void {
	SettingsPanel.show(context, logos, actions, tab);
}

async function writeColor(context: vscode.ExtensionContext, color: string | undefined): Promise<void> {
	// updateBgTone writes the repo's pulpfixer.json and then applies the tone (idempotent, serialized).
	await updateBgTone(context, 'color', color);
}

async function pickLogo(context: vscode.ExtensionContext): Promise<void> {
	if (!ensureWorkspace()) {
		return;
	}
	const rel = await pickLogoPath();
	if (rel) {
		await updateBgTone(context, 'logo', rel);
	}
}

async function clearLogo(context: vscode.ExtensionContext): Promise<void> {
	if (!ensureWorkspace()) {
		return;
	}
	await updateBgTone(context, 'logo', undefined);
}

type ColorPickItem = vscode.QuickPickItem & {
	action: 'preset' | 'none' | 'custom' | 'settings';
	color?: string;
};

async function setColor(context: vscode.ExtensionContext): Promise<void> {
	if (!ensureWorkspace()) {
		return;
	}

	const items: ColorPickItem[] = [
		{ label: `$(settings-gear) ${SETTINGS_LABEL}`, description: 'Palette, intensity, areas and logo', action: 'settings' },
	];
	let lastGroup: string | undefined;
	for (const preset of mergePalette(readConfig().palette)) {
		if (preset.group !== lastGroup) {
			items.push({ label: preset.group, kind: vscode.QuickPickItemKind.Separator, action: 'preset' });
			lastGroup = preset.group;
		}
		items.push({ label: preset.label, description: preset.color, action: 'preset', color: preset.color });
	}
	items.push(
		{ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'none' },
		{ label: NO_COLOR_LABEL, description: 'Remove the tone from this workspace', action: 'none' },
		{ label: CUSTOM_LABEL, description: '', action: 'custom' },
	);

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Background Tone: Set Tone Color',
		placeHolder: 'Pick a tone for this workspace',
		matchOnDescription: true,
	});
	if (!picked) {
		return;
	}

	switch (picked.action) {
		case 'settings':
			await vscode.commands.executeCommand('bgTone.openSettings');
			return;
		case 'none':
			await writeColor(context, undefined);
			return;
		case 'preset':
			await writeColor(context, picked.color);
			return;
		case 'custom': {
			const color = await vscode.window.showInputBox({
				title: 'Background Tone: Custom Color',
				prompt: 'Hex color, e.g. #3b82f6',
				value: readConfig().color,
				validateInput: value => (parseHex(value) ? undefined : 'Enter a valid hex color (#rgb or #rrggbb).'),
			});
			if (color !== undefined) {
				await writeColor(context, color.trim());
			}
			return;
		}
	}
}

async function randomize(context: vscode.ExtensionContext): Promise<void> {
	if (!ensureWorkspace()) {
		return;
	}
	const name =
		vscode.workspace.workspaceFolders?.[0]?.name ??
		vscode.workspace.name ??
		'workspace';
	await writeColor(context, colorFromName(name));
}

/** Multi-select picker over every repo action; the ticked ones become buttons on the Repo Identity card. */
async function editActions(service: ActionsService): Promise<void> {
	if (!ensureWorkspace()) {
		return;
	}
	await service.refresh();
	const all = service.actions;
	if (all.length === 0) {
		void vscode.window.showInformationMessage('Background Tone: no repo actions found. Is pf installed and up to date?');
		return;
	}
	const items = all.map(a => ({
		label: `$(${a.icon}) ${a.label}`,
		description: `pf ${a.argv.join(' ')}`,
		picked: a.featured,
		id: a.id,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		title: 'Background Tone: Featured Repo Actions',
		placeHolder: 'Tick the actions to show as buttons on the Repo Identity card',
		canPickMany: true,
		matchOnDescription: true,
	});
	if (!picked) {
		return;
	}
	const { feature, unfeature } = diffFeatured(all, picked.map(p => p.id));
	const failures = [
		await service.setFeatured(feature, true),
		await service.setFeatured(unfeature, false),
	].filter((m): m is string => !!m);
	if (failures.length > 0) {
		void vscode.window.showErrorMessage(`Background Tone: could not save the featured actions. ${failures[0]}`);
	}
}

async function clear(context: vscode.ExtensionContext): Promise<void> {
	if (!ensureWorkspace()) {
		return;
	}
	await writeColor(context, undefined);
}
