import { execFile } from 'node:child_process';

/** Runs git in `cwd` (no shell: the arguments go straight to git). */
export function runGit(cwd: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		execFile(
			'git',
			args,
			{ cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: stderr || (error ? error.message : '') }),
		);
	});
}
