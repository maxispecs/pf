import { spawn } from 'node:child_process';
import path from 'node:path';
import { PACKAGE_NAME, REGISTRY_URL, pfHome } from '../constants.js';
import { capture } from '../exec.js';
import { readJson } from '../util.js';

const DAY = 24 * 60 * 60 * 1000;

interface State {
  checkedAt?: number;
  latest?: string;
}

function statePath(): string {
  return path.join(pfHome(), 'state.json');
}

/** Latest version seen by the last background check, if any. Never touches the network. */
export function cachedLatest(): string | undefined {
  return readJson<State>(statePath())?.latest;
}

/** Ask the registry for the latest published version. Slow: only for `pf update` and `pf doctor`. */
export function fetchLatest(timeoutMs = 20_000): { version?: string; error?: string } {
  const r = capture(['npm', 'view', PACKAGE_NAME, 'version', '--registry', REGISTRY_URL], {
    timeout: timeoutMs,
  });
  const v = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (r.ok && /^\d+\.\d+/.test(v)) return { version: v };
  const msg = (r.stderr.match(/npm (?:error|ERR!) (?:code )?(E\w+|\d{3}[^\n]*)/)?.[1] ?? r.stderr.trim().split('\n')[0] ?? '').trim();
  return { error: msg || 'registry unreachable' };
}

const BACKGROUND_SCRIPT = `
const [file, registry, pkg] = process.argv.slice(1);
const fs = require('fs'), path = require('path');
require('child_process').execFile('npm', ['view', pkg, 'version', '--registry', registry], { timeout: 20000 }, (e, o) => {
  const v = String(o || '').trim().split('\\n').pop().trim();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest: !e && /^\\d/.test(v) ? v : undefined }));
  } catch {}
});
`;

/**
 * Refresh the cached latest version in a detached process when it is older than a day.
 * Never blocks and never throws. Skipped in CI, without a terminal, or with PF_NO_UPDATE_CHECK.
 */
export function refreshInBackground(): void {
  try {
    if (process.env.PF_NO_UPDATE_CHECK || process.env.CI || !process.stderr.isTTY) return;
    const state = readJson<State>(statePath());
    if (state?.checkedAt && Date.now() - state.checkedAt < DAY) return;
    const child = spawn(process.execPath, ['-e', BACKGROUND_SCRIPT, statePath(), REGISTRY_URL, PACKAGE_NAME], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // an update check must never break a command
  }
}
