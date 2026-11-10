import fs from 'node:fs';
import path from 'node:path';
import { listDir } from '../util.js';

/**
 * A script at a repo's root that looks like its own developer helper with a deploy command, such as
 * `./tl d` or `./al d`. Such helpers have no `# usage:` headers, so pf only guesses; the setup
 * agent reads them and decides.
 */
export interface DeployHelper {
  /** File name at the repo root, e.g. `tl`. */
  file: string;
  /** Runs from the checkout on a dev machine (`GWLOCAL`). */
  local: boolean;
  /** Needs a server (`$GWHOME`, `systemctl`, `sudo`) and is not marked local. pf never wires these. */
  serverOnly: boolean;
  /** Has a `"$1" = "d"` or `"deploy"` branch, not just the word. */
  branch: boolean;
  /** Best first. */
  score: number;
  reasons: string[];
}

const MAX_BYTES = 200_000;
const D_BRANCH = /\$\{?1\}?"?\s*(?:=|==)\s*"(?:d|deploy)"/;

function scan(file: string, text: string): DeployHelper | null {
  const branch = D_BRANCH.test(text);
  const word = /\bdeploy\b/i.test(text);
  if (!branch && !word) return null;
  const local = /\bGWLOCAL\b/.test(text);
  const serverOnly = !local && /\$\{?GWHOME\b|\bsystemctl\b|\bsudo\b/.test(text);
  const reasons = [
    branch ? 'has a "$1" = "d"/"deploy" branch' : 'mentions deploy',
    ...(local ? ['marked local (GWLOCAL)'] : []),
    ...(serverOnly ? ['uses $GWHOME, systemctl or sudo (server only)'] : []),
  ];
  return { file, local, serverOnly, branch, score: (local ? 10 : 0) - (serverOnly ? 5 : 0) + (branch ? 3 : 0) + (word ? 1 : 0), reasons };
}

/**
 * Executable scripts (with a shebang) directly in `root` that mention deploying, best candidate first.
 * Hidden files, directories (a `deploy/` folder is not a command) and big files are skipped.
 */
export function findDeployHelpers(root: string): DeployHelper[] {
  const found: DeployHelper[] = [];
  for (const name of listDir(root)) {
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_BYTES || (st.mode & 0o111) === 0) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!text.startsWith('#!')) continue;
      const helper = scan(name, text);
      if (helper) found.push(helper);
    } catch {
      // unreadable: skip
    }
  }
  return found.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
