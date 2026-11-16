import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RepoAction, commandLine, parseActions } from './actions.ts';
import { primaryFolder } from './store.ts';

/** Files whose change can add or remove an action (what pf's detection reads, plus its own config). */
const WATCHED = '{pulpfixer.json,pf.json,package.json,composer.json,Makefile,makefile,justfile,Justfile,a}';
const EXEC_TIMEOUT_MS = 15_000;
const DEBOUNCE_MS = 400;

export type ActionsStatus =
	/** The list is loaded (it may be empty). */
	| { type: 'ready' }
	| { type: 'loading' }
	/** Not a local folder, or the workspace is not trusted. */
	| { type: 'unavailable'; reason: string }
	| { type: 'no-pf' }
	/** pf runs but has no `actions` command yet. */
	| { type: 'old-pf' }
	| { type: 'error'; reason: string };

/** The configured pf command. Machine scope, so a repo's .vscode/settings.json cannot change what is run. */
export function pfCommand(): string {
	const value = vscode.workspace.getConfiguration('bgTone').get<string>('pfPath', 'pf');
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'pf';
}

function run(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{ cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1' } },
			(error, stdout, stderr) => {
				if (error) {
					reject(Object.assign(error, { stdout, stderr }));
				} else {
					resolve({ stdout, stderr });
				}
			},
		);
	});
}

/** Where a GUI-launched editor (a short PATH) can still find a globally installed pf. */
function fallbackPaths(): string[] {
	const home = os.homedir();
	return [
		'/opt/homebrew/bin/pf',
		'/usr/local/bin/pf',
		path.join(home, '.local', 'bin', 'pf'),
		path.join(home, '.npm-global', 'bin', 'pf'),
		path.join(home, '.volta', 'bin', 'pf'),
	].filter(p => fs.existsSync(p));
}

function loginShellLookup(): Promise<string | undefined> {
	if (process.platform === 'win32' || !process.env.SHELL) {
		return Promise.resolve(undefined);
	}
	return run(process.env.SHELL, ['-lc', 'command -v pf'], os.homedir())
		.then(r => r.stdout.trim().split('\n').pop()?.trim() || undefined)
		.catch(() => undefined);
}

/**
 * The repo's actions from `pf actions --all --json`, and the terminal they run in. Nothing here runs a
 * string that came from the repo or the webview: a click names an action id, the argv is pf's own list
 * and the executable is the machine-scoped `bgTone.pfPath`.
 */
export class ActionsService implements vscode.Disposable {
	private all: RepoAction[] = [];
	private state: ActionsStatus = { type: 'loading' };
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private resolvedPf: string | undefined;
	private writes: Promise<void> = Promise.resolve();
	private watcher: vscode.FileSystemWatcher | undefined;
	private readonly busy = new Set<vscode.Terminal>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(
			this.emitter,
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.rewatch();
				this.refreshSoon();
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshSoon()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('bgTone.pfPath')) {
					this.resolvedPf = undefined;
					this.refreshSoon();
				}
			}),
			vscode.window.onDidCloseTerminal(t => this.busy.delete(t)),
		);
		// Shell integration (VS Code 1.93+) tells us whether a terminal is still running an action.
		if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
			this.disposables.push(
				vscode.window.onDidStartTerminalShellExecution(e => this.busy.add(e.terminal)),
				vscode.window.onDidEndTerminalShellExecution(e => this.busy.delete(e.terminal)),
			);
		}
		this.rewatch();
	}

	get status(): ActionsStatus {
		return this.state;
	}

	/** Every action, featured or not. */
	get actions(): readonly RepoAction[] {
		return this.all;
	}

	get featured(): RepoAction[] {
		return this.all.filter(a => a.featured);
	}

	/** Re-reads the list soon; a burst of file changes is one run. */
	refreshSoon(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.refresh();
		}, DEBOUNCE_MS);
	}

	async refresh(): Promise<void> {
		const generation = ++this.generation;
		const next = await this.load();
		if (generation !== this.generation) {
			return; // a newer refresh superseded this one
		}
		this.all = next.actions;
		this.state = next.status;
		this.emitter.fire();
	}

	private async load(): Promise<{ status: ActionsStatus; actions: RepoAction[] }> {
		const folder = primaryFolder();
		if (!folder || folder.uri.scheme !== 'file') {
			return { status: { type: 'unavailable', reason: 'local folders only' }, actions: [] };
		}
		if (!vscode.workspace.isTrusted) {
			return { status: { type: 'unavailable', reason: 'workspace not trusted' }, actions: [] };
		}
		const args = ['actions', '--all', '--json'];
		const cwd = folder.uri.fsPath;
		try {
			const { stdout } = await this.exec(args, cwd);
			const parsed = parseActions(stdout);
			return parsed.ok
				? { status: { type: 'ready' }, actions: parsed.actions }
				: { status: { type: 'error', reason: parsed.reason }, actions: [] };
		} catch (e) {
			const err = e as NodeJS.ErrnoException & { stderr?: string };
			if (err.code === 'ENOENT') {
				return { status: { type: 'no-pf' }, actions: [] };
			}
			if (/unknown command/i.test(err.stderr ?? '')) {
				return { status: { type: 'old-pf' }, actions: [] };
			}
			const detail = (err.stderr ?? '').trim().split('\n').pop() || err.message;
			return { status: { type: 'error', reason: detail }, actions: [] };
		}
	}

	/** Runs pf; when the configured `pf` is not on this process's PATH, tries the usual install places and a login shell once. */
	private async exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
		const configured = pfCommand();
		if (this.resolvedPf) {
			return run(this.resolvedPf, args, cwd);
		}
		try {
			return await run(configured, args, cwd);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || configured !== 'pf') {
				throw e;
			}
			for (const candidate of [...fallbackPaths(), await loginShellLookup()]) {
				if (!candidate) {
					continue;
				}
				try {
					const result = await run(candidate, args, cwd);
					this.resolvedPf = candidate;
					return result;
				} catch (inner) {
					if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') {
						this.resolvedPf = candidate;
						throw inner;
					}
				}
			}
			throw e;
		}
	}

	/** Runs `pf actions feature|unfeature <ids>` (pf owns the pulpfixer.json section), then reloads. */
	setFeatured(ids: string[], featured: boolean): Promise<string | undefined> {
		// One write at a time: two pf processes editing pulpfixer.json together could drop a change.
		const result = this.writes.then(() => this.writeFeatured(ids, featured));
		this.writes = result.then(() => undefined);
		return result;
	}

	private async writeFeatured(ids: string[], featured: boolean): Promise<string | undefined> {
		const folder = primaryFolder();
		if (!folder || ids.length === 0) {
			return undefined;
		}
		if (!vscode.workspace.isTrusted) {
			return 'the workspace is not trusted';
		}
		try {
			await this.exec(['actions', featured ? 'feature' : 'unfeature', ...ids], folder.uri.fsPath);
		} catch (e) {
			const err = e as Error & { stderr?: string };
			return (err.stderr ?? '').trim().split('\n').pop() || err.message;
		}
		await this.refresh();
		return undefined;
	}

	/** Runs an action in its own terminal (reused when idle). Returns false when the id is unknown. */
	runAction(id: string): boolean {
		const action = this.all.find(a => a.id === id);
		const folder = primaryFolder();
		if (!action || !folder) {
			return false;
		}
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Background Tone: trust this workspace to run repo actions.');
			return true;
		}
		const name = `pf: ${action.label}`;
		const existing = vscode.window.terminals.find(t => t.name === name && t.exitStatus === undefined);
		if (existing && this.busy.has(existing)) {
			// Still running: show it instead of typing into a running process.
			existing.show();
			return true;
		}
		// Without shell integration we cannot tell whether a terminal is idle, so only a known-idle one is reused.
		const reusable = existing?.shellIntegration !== undefined ? existing : undefined;
		const terminal = reusable ?? vscode.window.createTerminal({ name, cwd: folder.uri });
		terminal.show();
		terminal.sendText(commandLine(pfCommand(), action.argv));
		return true;
	}

	private rewatch(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
		const folder = primaryFolder();
		if (!folder) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, WATCHED));
		const changed = () => this.refreshSoon();
		watcher.onDidChange(changed);
		watcher.onDidCreate(changed);
		watcher.onDidDelete(changed);
		this.watcher = watcher;
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.watcher?.dispose();
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}
}
