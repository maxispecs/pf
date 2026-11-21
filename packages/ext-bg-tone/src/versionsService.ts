import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ActionsService } from './actionsService.ts';
import { runGit } from './git.ts';
import { VERSIONS_FILE } from './stackVersion.ts';
import { primaryFolder } from './store.ts';
import { NO_VERSIONS, VersionsState, planBump, planFeature, parseVersionsFile, stackBumpedSinceHead, versionsState } from './versions.ts';

function localFolder(): vscode.WorkspaceFolder | undefined {
	const folder = primaryFolder();
	return folder?.uri.scheme === 'file' ? folder : undefined;
}

function readVersionsText(): string | null {
	const folder = localFolder();
	if (!folder) {
		return null;
	}
	try {
		return fs.readFileSync(path.join(folder.uri.fsPath, VERSIONS_FILE), 'utf8');
	} catch {
		return null;
	}
}

/** True when the repo has a valid `versions.json` (what decides whether the Versions view exists). */
export function hasVersionsFile(): boolean {
	return parseVersionsFile(readVersionsText()) !== undefined;
}

/**
 * Whether the stack was already bumped since the last commit (see `stackBumpedSinceHead`). Without git there
 * is no "next commit", so it is never considered bumped; inside git, a `versions.json` that HEAD does not
 * have (no commits yet, or a new file) counts as bumped.
 */
async function stackDone(cwd: string, currentText: string | null): Promise<boolean> {
	const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], 5000);
	if (!inside.ok) {
		return false;
	}
	const head = await runGit(cwd, ['show', `HEAD:${VERSIONS_FILE}`], 5000);
	return stackBumpedSinceHead(head.ok ? head.stdout : null, currentText);
}

function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

/**
 * The versions of the repo (`versions.json`, kept by the `ver` CLI) for the card and the Versions view, and
 * the bump a `[+]` click asks for. A click names a target and a part; both are checked against the file just
 * read. Only versions.json is written here, then `pf ver sync` rewrites the manifests and runs the hooks.
 */
export class VersionsService {
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly actions: ActionsService) {}

	/** What the page draws now. */
	async state(): Promise<VersionsState> {
		const folder = localFolder();
		const text = readVersionsText();
		const file = parseVersionsFile(text);
		if (!folder || !file) {
			return NO_VERSIONS;
		}
		const trusted = vscode.workspace.isTrusted;
		return versionsState(file, {
			stackDone: await stackDone(folder.uri.fsPath, text),
			canBump: trusted,
			hint: trusted ? '' : 'Trust this workspace to bump versions.',
		});
	}

	/** Bumps one target. One at a time, so quick clicks cannot read the same file. Resolves true when the file changed. */
	bump(target: unknown, part: unknown): Promise<boolean> {
		const result = this.queue.then(() => this.run(target, part));
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	/** Features or unfeatures one package (the star). Same queue and checks as a bump; no version changes, so no sync. */
	setFeatured(target: unknown, on: unknown): Promise<boolean> {
		const result = this.queue.then(() => this.runFeature(target, on));
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async runFeature(target: unknown, on: unknown): Promise<boolean> {
		const folder = localFolder();
		if (!folder) {
			return false;
		}
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Background Tone: trust this workspace to feature packages.');
			return false;
		}
		const plan = planFeature(readVersionsText(), target, on);
		if (!plan.ok) {
			void vscode.window.showErrorMessage(`Background Tone: cannot ${on === false ? 'unfeature' : 'feature'}: ${plan.reason}.`);
			return false;
		}
		if (!plan.changed) {
			return false;
		}
		try {
			writeAtomic(path.join(folder.uri.fsPath, VERSIONS_FILE), plan.text);
		} catch (e) {
			void vscode.window.showErrorMessage(`Background Tone: could not write ${VERSIONS_FILE}: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
		return true;
	}

	private async run(target: unknown, part: unknown): Promise<boolean> {
		const folder = localFolder();
		if (!folder) {
			return false;
		}
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Background Tone: trust this workspace to bump versions.');
			return false;
		}
		const cwd = folder.uri.fsPath;
		const text = readVersionsText();
		const plan = planBump(text, target, part, { stackDone: await stackDone(cwd, text) });
		if (!plan.ok) {
			void vscode.window.showErrorMessage(`Background Tone: cannot bump: ${plan.reason}.`);
			return false;
		}
		try {
			writeAtomic(path.join(cwd, VERSIONS_FILE), plan.text);
		} catch (e) {
			void vscode.window.showErrorMessage(`Background Tone: could not write ${VERSIONS_FILE}: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
		const summary = plan.changes.map(c => `${c.target} ${c.from} -> ${c.to}`).join(', ');
		try {
			await this.actions.runPf(['ver', 'sync'], cwd);
		} catch (e) {
			const err = e as NodeJS.ErrnoException & { stderr?: string };
			const detail = err.code === 'ENOENT' ? 'pf was not found' : ((err.stderr ?? '').trim().split('\n').pop() || err.message);
			void vscode.window.showWarningMessage(
				`Background Tone: bumped ${summary} in ${VERSIONS_FILE}, but "pf ver sync" failed (${detail}). Run it to update the package manifests.`.slice(0, 300),
			);
			return true;
		}
		void vscode.window.showInformationMessage(`Background Tone: bumped ${summary}.`);
		return true;
	}
}
