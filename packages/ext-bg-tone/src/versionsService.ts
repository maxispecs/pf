import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ActionsService } from './actionsService.ts';
import { runGit } from './git.ts';
import { VERSIONS_FILE } from './stackVersion.ts';
import { primaryFolder } from './store.ts';
import { planCategorize, planCategoryEdit } from './categories.ts';
import type { CategoryEdit, CategoryPlan } from './categories.ts';
import {
	NO_VERSIONS,
	PendingCommit,
	VersionsFile,
	VersionsState,
	commitMessage,
	hookCommands,
	pendingChanges,
	planBump,
	planFeature,
	parseVersionsFile,
	stackBumpedSinceHead,
	versionFileCandidates,
	versionsState,
} from './versions.ts';

/** `git` with literal pathspecs: a package path is a file name here, never a glob. */
const GIT = '--literal-pathspecs';

/** The last lines of command output, where a failing hook or git hook says why. */
function tail(text: string, lines = 4): string {
	return text.trim().split('\n').filter(Boolean).slice(-lines).join(' ');
}

const shellQuote = (s: string): string => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

function runShell(cwd: string, command: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
	return new Promise(resolve => {
		exec(command, { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) =>
			resolve({ ok: !error, output: `${stdout}${stderr}` || (error ? error.message : '') }),
		);
	});
}

/**
 * Tracked files that differ from HEAD (paths relative to `cwd`), each with a hash of its content, so two
 * snapshots tell which files a command touched even when they were already modified. Empty without a HEAD.
 */
async function changedFiles(cwd: string, only?: string[]): Promise<Map<string, string>> {
	const result = await runGit(cwd, [GIT, 'diff', '--name-only', '-z', '--relative', 'HEAD', ...(only ? ['--', ...only] : [])], 10_000);
	const files = new Map<string, string>();
	if (!result.ok) {
		return files;
	}
	for (const name of result.stdout.split('\0').filter(Boolean)) {
		let hash = 'missing';
		try {
			hash = createHash('sha1').update(fs.readFileSync(path.join(cwd, name))).digest('hex');
		} catch {
			// deleted or unreadable
		}
		files.set(name, hash);
	}
	return files;
}

/** Names whose hash differs between two snapshots (new ones included). */
function touchedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
	return [...after].filter(([name, hash]) => before.get(name) !== hash).map(([name]) => name);
}

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

/** `versions.json` as HEAD has it: undefined outside a git work tree, null when HEAD has no such file (no commits, new file). */
async function headVersionsText(cwd: string): Promise<string | null | undefined> {
	const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], 5000);
	if (!inside.ok) {
		return undefined;
	}
	const head = await runGit(cwd, ['show', `HEAD:./${VERSIONS_FILE}`], 5000);
	return head.ok ? head.stdout : null;
}

/**
 * Whether the stack was already bumped since the last commit (see `stackBumpedSinceHead`). Without git there
 * is no "next commit", so it is never considered bumped; inside git, a `versions.json` that HEAD does not
 * have (no commits yet, or a new file) counts as bumped.
 */
async function stackDone(cwd: string, currentText: string | null): Promise<boolean> {
	const head = await headVersionsText(cwd);
	return head !== undefined && stackBumpedSinceHead(head, currentText);
}

/** The bumps waiting for a commit: `versions.json` has version changes HEAD does not. */
function pendingCommit(head: string | null | undefined, currentText: string | null): PendingCommit | null {
	const changes = pendingChanges(head, currentText);
	return changes.length ? { message: commitMessage(changes) } : null;
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
	/** Files a bump of this session changed beyond the manifests we can guess (what `postSync` hooks wrote); cleared by a commit. */
	private readonly touched = new Set<string>();

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
		const head = await headVersionsText(folder.uri.fsPath);
		return versionsState(file, {
			stackDone: head !== undefined && stackBumpedSinceHead(head, text),
			pending: pendingCommit(head, text),
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

	/** The parsed `versions.json` as it is now (undefined without a valid one): what the category pickers list. */
	current(): VersionsFile | undefined {
		return parseVersionsFile(readVersionsText());
	}

	/** Puts one package in a category, or takes it out (`null`). Same queue and checks as the star; no version changes, so no sync. */
	setCategory(target: unknown, category: unknown): Promise<boolean> {
		return this.edit('assign categories', text => planCategorize(text, target, category));
	}

	/** Adds, recolors, renames, moves or removes a category. Same queue and checks; no version changes, so no sync. */
	editCategories(edit: CategoryEdit): Promise<boolean> {
		return this.edit('edit categories', text => planCategoryEdit(text, edit));
	}

	/** Runs one plan over the file just read, in the queue, in a trusted local workspace. True when the file changed. */
	private edit(what: string, plan: (text: string | null) => CategoryPlan): Promise<boolean> {
		const result = this.queue.then(() => this.runEdit(what, plan));
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async runEdit(what: string, make: (text: string | null) => CategoryPlan): Promise<boolean> {
		const folder = localFolder();
		if (!folder) {
			return false;
		}
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage(`Background Tone: trust this workspace to ${what}.`);
			return false;
		}
		const plan = make(readVersionsText());
		if (!plan.ok) {
			void vscode.window.showErrorMessage(`Background Tone: cannot ${what}: ${plan.reason}.`);
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
		// What the bump and its sync (hooks included) change is what the commit button commits.
		const before = await changedFiles(cwd);
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
			this.remember(before, await changedFiles(cwd));
			const err = e as NodeJS.ErrnoException & { stderr?: string };
			const detail = err.code === 'ENOENT' ? 'pf was not found' : ((err.stderr ?? '').trim().split('\n').pop() || err.message);
			void vscode.window.showWarningMessage(
				`Background Tone: bumped ${summary} in ${VERSIONS_FILE}, but "pf ver sync" failed (${detail}). Run it to update the package manifests.`.slice(0, 300),
			);
			return true;
		}
		this.remember(before, await changedFiles(cwd));
		void vscode.window.showInformationMessage(`Background Tone: bumped ${summary}.`);
		return true;
	}

	private remember(before: Map<string, string>, after: Map<string, string>): void {
		for (const name of touchedBetween(before, after)) {
			this.touched.add(name);
		}
	}

	/**
	 * Commits the bumps (the commit button, like the ver CLI's "Commit changed files"): only the files the bumps
	 * changed (`versions.json`, the synced manifests, what `postSync` hooks wrote), never other work. It commits
	 * at once with the generated message (`Bump versions: ...`), no dialog. `preCommit` hooks of `versions.json` run first and the
	 * files they change join the commit; if git's own hooks reformat the files the commit is retried once.
	 * Resolves true when something changed (redraw).
	 */
	commit(): Promise<boolean> {
		const result = this.queue.then(() => this.runCommit());
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async runCommit(): Promise<boolean> {
		const folder = localFolder();
		if (!folder) {
			return false;
		}
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Background Tone: trust this workspace to commit versions.');
			return false;
		}
		const cwd = folder.uri.fsPath;
		const text = readVersionsText();
		const file = parseVersionsFile(text);
		const changes = pendingChanges(await headVersionsText(cwd), text);
		if (!file || !changes.length) {
			void vscode.window.showInformationMessage('Background Tone: no version bump is waiting for a commit.');
			return true;
		}
		const hooks = hookCommands(file, 'preCommit');
		if (!hooks.ok) {
			void vscode.window.showErrorMessage(`Background Tone: cannot commit: ${hooks.reason}.`);
			return false;
		}
		const candidates = [...versionFileCandidates(changes, VERSIONS_FILE), ...this.touched];
		const files = new Set((await changedFiles(cwd, candidates)).keys());
		if (!files.size) {
			void vscode.window.showInformationMessage('Background Tone: the version files have no changes to commit.');
			return true;
		}
		const noun = files.size === 1 ? '1 file' : `${files.size} files`;
		// No dialog: the button commits with the generated message (the same one its tooltip shows).
		const message = commitMessage(changes);
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Committing ${noun}...` }, async () => {
			const env = {
				...process.env,
				VER_ROOT: cwd,
				VER_EVENT: 'preCommit',
				VER_STACK: file.stack.version,
				VER_CHANGES: JSON.stringify(changes.map(c => [c.target, c.from, c.to])),
			};
			for (const command of hooks.commands) {
				const current = [...files];
				const before = await changedFiles(cwd);
				const run = await runShell(cwd, command.split('{files}').join(current.map(shellQuote).join(' ')), { ...env, VER_FILES: current.join('\n') });
				if (!run.ok) {
					void vscode.window.showErrorMessage(`Background Tone: preCommit hook failed: ${command}: ${tail(run.output)}`.slice(0, 300));
					return true;
				}
				for (const name of touchedBetween(before, await changedFiles(cwd))) {
					files.add(name);
				}
			}
			const paths = [...files];
			const attempt = async () => {
				const add = await runGit(cwd, [GIT, 'add', '--', ...paths], 30_000);
				if (!add.ok) {
					return add;
				}
				return runGit(cwd, [GIT, 'commit', '-m', message.trim(), '--', ...paths], 120_000);
			};
			const before = await changedFiles(cwd, paths);
			let commit = await attempt();
			if (!commit.ok) {
				// The repo's own git hooks (formatters) may have rewritten the files: stage them again, once.
				if (touchedBetween(before, await changedFiles(cwd, paths)).length) {
					commit = await attempt();
				}
				if (!commit.ok) {
					void vscode.window.showErrorMessage(`Background Tone: git commit failed: ${tail(`${commit.stdout}\n${commit.stderr}`, 3)}`.slice(0, 300));
					return true; // files may be staged now: redraw
				}
			}
			this.touched.clear();
			void vscode.window.showInformationMessage(`Background Tone: committed ${noun}.`);
			return true;
		});
	}
}
