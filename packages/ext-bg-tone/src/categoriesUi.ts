/**
 * The pickers behind the Versions pane's category controls: give a package a category, and manage the list
 * (add, color, rename, reorder, remove). Quick picks and input boxes only; every write goes through
 * `VersionsService`, which validates it against the file just read.
 */
import * as vscode from 'vscode';
import { CATEGORY_PALETTE, categoryCounts, validateCategoryColor, validateCategoryName } from './categories.ts';
import type { VersionsService } from './versionsService.ts';

type Choice<T> = vscode.QuickPickItem & { act: T };

const TITLE = 'Background Tone';
const lastSegment = (target: string): string => target.split('/').filter(Boolean).pop() ?? target;

/** A color for a category: the palette, none, or a custom hex. `undefined` when cancelled, `null` for no color. */
async function pickColor(name: string, current: string | undefined): Promise<{ color: string | null } | undefined> {
	const items: Choice<{ color: string | null } | 'custom'>[] = [
		...CATEGORY_PALETTE.map(p => ({
			label: `$(circle-filled) ${p.label}`,
			description: p.color === current ? `${p.color} (current)` : p.color,
			act: { color: p.color },
		})),
		{ label: '', kind: vscode.QuickPickItemKind.Separator, act: { color: null } },
		{ label: '$(circle-slash) No color', description: 'List it without a tint', act: { color: null } },
		{ label: '$(edit) Custom hex color...', act: 'custom' },
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: `${TITLE}: Color for "${name}"`,
		placeHolder: 'Rows of the category get a light tint of this color',
		matchOnDescription: true,
	});
	if (!picked) {
		return undefined;
	}
	if (picked.act !== 'custom') {
		return picked.act;
	}
	const hex = await vscode.window.showInputBox({
		title: `${TITLE}: Custom Color`,
		prompt: 'Hex color, e.g. #3b82f6',
		value: current,
		validateInput: validateCategoryColor,
	});
	return hex === undefined ? undefined : { color: hex.trim() };
}

/** Asks for a name and a color and adds the category. Resolves with the new name, or undefined when cancelled or refused. */
async function createCategory(service: VersionsService): Promise<string | undefined> {
	const existing = service.current()?.categories.map(c => c.name) ?? [];
	const name = await vscode.window.showInputBox({
		title: `${TITLE}: New Version Category`,
		prompt: 'Name of the category (groups packages in the Versions list)',
		validateInput: value => validateCategoryName(value, existing),
	});
	if (name === undefined) {
		return undefined;
	}
	const color = await pickColor(name, undefined);
	if (!color) {
		return undefined;
	}
	const done = await service.editCategories({ kind: 'add', name, ...(color.color ? { color: color.color } : {}) });
	return done ? name : undefined;
}

/** The picker a package's tag button opens: choose its category, take it out of one, or make a new one for it. */
export async function pickCategory(service: VersionsService, target: unknown): Promise<void> {
	const file = service.current();
	if (!file || typeof target !== 'string' || !Object.prototype.hasOwnProperty.call(file.packages, target)) {
		return;
	}
	const now = typeof file.packages[target].category === 'string' ? (file.packages[target].category as string) : undefined;
	const items: Choice<{ name: string } | 'none' | 'new'>[] = [
		...file.categories.map(c => ({
			label: `$(circle-filled) ${c.name}`,
			description: [c.color, c.name === now ? 'current' : ''].filter(Boolean).join('  '),
			act: { name: c.name },
		})),
		{ label: '', kind: vscode.QuickPickItemKind.Separator, act: 'none' },
		...(now ? [{ label: '$(circle-slash) No category', description: `Take ${lastSegment(target)} out of "${now}"`, act: 'none' as const }] : []),
		{ label: '$(add) New category...', act: 'new' },
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: `${TITLE}: Category of ${lastSegment(target)}`,
		placeHolder: file.categories.length ? 'Pick a category' : 'No categories yet: make the first one',
		matchOnDescription: true,
	});
	if (!picked) {
		return;
	}
	if (picked.act === 'none') {
		await service.setCategory(target, null);
	} else if (picked.act === 'new') {
		const name = await createCategory(service);
		if (name) {
			await service.setCategory(target, name);
		}
	} else if (picked.act.name !== now) {
		await service.setCategory(target, picked.act.name);
	}
}

type ManageAct = { name: string } | 'new';
type CategoryAct = 'color' | 'rename' | 'up' | 'down' | 'remove';

/** The category manager: the list (with package counts) and, per category, color, rename, order and remove. */
export async function manageCategories(service: VersionsService): Promise<void> {
	for (;;) {
		const file = service.current();
		if (!file) {
			return;
		}
		const counts = categoryCounts(file);
		const items: Choice<ManageAct>[] = [
			...file.categories.map((c, i) => ({
				label: `$(circle-filled) ${c.name}`,
				description: c.color ?? 'no color',
				detail: `${counts.get(c.name)} package${counts.get(c.name) === 1 ? '' : 's'}, group ${i + 1} of ${file.categories.length}`,
				act: { name: c.name },
			})),
			{ label: '', kind: vscode.QuickPickItemKind.Separator, act: 'new' },
			{ label: '$(add) New category...', act: 'new' },
		];
		const picked = await vscode.window.showQuickPick(items, {
			title: `${TITLE}: Version Categories`,
			placeHolder: file.categories.length ? 'Pick a category to change, or add one (use the tag on a package row to assign)' : 'No categories yet',
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}
		if (picked.act === 'new') {
			await createCategory(service);
			continue;
		}
		await editOne(service, picked.act.name);
	}
}

async function editOne(service: VersionsService, name: string): Promise<void> {
	const file = service.current();
	const at = file?.categories.findIndex(c => c.name === name) ?? -1;
	if (!file || at < 0) {
		return;
	}
	const count = categoryCounts(file).get(name) ?? 0;
	const items: Choice<CategoryAct>[] = [
		{ label: '$(symbol-color) Change color...', act: 'color' },
		{ label: '$(edit) Rename...', act: 'rename' },
		...(at > 0 ? [{ label: '$(arrow-up) Move up', description: 'List it earlier', act: 'up' as const }] : []),
		...(at < file.categories.length - 1 ? [{ label: '$(arrow-down) Move down', description: 'List it later', act: 'down' as const }] : []),
		{ label: '$(trash) Remove...', description: `${count} package${count === 1 ? '' : 's'} lose it`, act: 'remove' },
	];
	const picked = await vscode.window.showQuickPick(items, { title: `${TITLE}: Category "${name}"` });
	if (!picked) {
		return;
	}
	switch (picked.act) {
		case 'color': {
			const color = await pickColor(name, file.categories[at].color);
			if (color) {
				await service.editCategories({ kind: 'color', name, color: color.color });
			}
			return;
		}
		case 'rename': {
			const to = await vscode.window.showInputBox({
				title: `${TITLE}: Rename "${name}"`,
				value: name,
				validateInput: value => validateCategoryName(value, file.categories.map(c => c.name), name),
			});
			if (to !== undefined) {
				await service.editCategories({ kind: 'rename', name, to });
			}
			return;
		}
		case 'up':
		case 'down':
			await service.editCategories({ kind: 'move', name, by: picked.act === 'up' ? -1 : 1 });
			return;
		case 'remove': {
			const answer = await vscode.window.showWarningMessage(
				`Remove the category "${name}"? Its ${count} package${count === 1 ? '' : 's'} stay in the list without a category.`,
				{ modal: true },
				'Remove',
			);
			if (answer === 'Remove') {
				await service.editCategories({ kind: 'remove', name });
			}
			return;
		}
	}
}
