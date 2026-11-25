import fs from 'node:fs';
import path from 'node:path';
import { listDir } from '../util.js';

/**
 * A script at a repo's root that looks like its own developer helper with a deploy command, such as
 * `./tl d` or `./al d`. Such helpers have no `# usage:` headers, so pf only guesses; the setup
 * agent reads them and decides.
 *
 * A script is a candidate only when it has a deploy entry point: a `"$1" = "d"` / `"deploy"` branch
 * (a `case "$1"` label counts too), or a file name that says deploy (`deploy.sh`, `deploy-staging.sh`).
 * The word "deploy" somewhere in the text is not enough. A candidate is `eligible` (the one pf offers to
 * wire) only when it is a whole deploy that runs from this checkout, so these are listed but never
 * offered: one step of a deploy (`deploy_migrations.sh`), a hook the platform runs on the server
 * (`appspec.yml`), a stub that does nothing, and anything that needs the server.
 */
export interface DeployHelper {
  /** File name at the repo root, e.g. `tl`. */
  file: string;
  /** Runs from the checkout on a dev machine (`GWLOCAL`). */
  local: boolean;
  /** Needs a server (`$GWHOME`, `systemctl`, `sudo`, `/var/www`) and is not marked local. pf never wires these. */
  serverOnly: boolean;
  /** Has a `"$1" = "d"` or `"deploy"` branch (or case label), not just the word. */
  branch: boolean;
  /** The whole deploy, or only one step of it (migrations, cache, assets, a hook, ...). */
  role: 'deploy' | 'step';
  /** Set when a platform runs this script on the server, e.g. `appspec.yml AfterInstall`. */
  hook?: string;
  /** Every command is commented out or only prints, so it does nothing. */
  stub: boolean;
  /** A whole deploy that runs from this checkout: the only kind pf offers to wire. */
  eligible: boolean;
  /** Why it is not eligible, readable; set exactly when `eligible` is false. */
  rejected?: string;
  /** Best first. */
  score: number;
  reasons: string[];
}

const MAX_BYTES = 200_000;

/** Words that may stand next to "deploy" in a name or label without making it part of one: where it goes, or "all of it". */
const WHOLE_WORDS = new Set([
  'staging', 'stage', 'stg', 'prod', 'production', 'live', 'dev', 'development', 'test', 'qa', 'uat',
  'app', 'all', 'full', 'site', 'web', 'now', 'it', 'local', 'remote', 'cloud', 'to', 'sh', 'bash',
]);

/**
 * `deploy` and `deploy-staging` are the whole deploy; `deploy_migrations` or `deploy-api` are not
 * (the part is named). `short` also accepts the bare `d`. Null when the text is not about deploying.
 */
export function deployRole(label: string, short = false): { role: 'deploy' | 'step'; part?: string } | null {
  const text = label.toLowerCase();
  if (short && text === 'd') return { role: 'deploy' };
  const tokens = text.split(/[-_.:\s]+/).filter(Boolean);
  if (!tokens.includes('deploy')) return null;
  const others = tokens.filter((x) => x !== 'deploy');
  const part = others.filter((x) => !WHOLE_WORDS.has(x));
  return part.length ? { role: 'step', part: part.join(' ') } : { role: 'deploy' };
}

/** A script's live lines: comments and blank lines dropped (the shebang is a comment too). */
function liveLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Lines that print or leave but do nothing else; a script of only these is a stub. */
const IDLE = /^(?:echo|printf|:|true|exit|return|set)\b/;

/** A plain `NAME=value` line, and shell punctuation: neither does anything by itself. */
const ASSIGN = /^[A-Za-z_]\w*=\S*$/;
const STRUCTURE = /^(?:fi|then|else|esac|;;|done|do|\{|\})$/;

/** `"$1" = "d"` and `[[ $1 == deploy ]]` style comparisons. */
const EQ = /\$\{?1\}?"?\s*==?\s*(?:["']([\w:.-]+)["']|([\w:.-]+))/g;
const CASE = /\bcase\s+"?\$\{?1\}?"?\s+in\b/;
const CASE_LABEL = /^\(?\s*((?:["']?[\w:.-]+["']?\s*\|\s*)*["']?[\w:.-]+["']?)\s*\)/;

/** What `$1` is compared with, as written. */
function branchLabels(live: string[]): string[] {
  const labels: string[] = [];
  for (const line of live) for (const m of line.matchAll(EQ)) labels.push(m[1] ?? m[2]!);
  if (live.some((l) => CASE.test(l))) {
    for (const line of live) {
      const m = CASE_LABEL.exec(line);
      if (m) for (const alt of m[1]!.split('|')) labels.push(alt.trim().replace(/^["']|["']$/g, ''));
    }
  }
  return labels;
}

/** `appspec.yml` hook scripts: location (as written, `./` dropped) -> `appspec.yml AfterInstall`. */
function platformHooks(root: string): Map<string, string> {
  const hooks = new Map<string, string>();
  for (const name of ['appspec.yml', 'appspec.yaml']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    let event = 'a hook';
    let inHooks = false;
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      if (/^hooks:\s*$/.test(raw)) {
        inHooks = true;
        continue;
      }
      if (/^\S/.test(raw)) inHooks = false;
      if (!inHooks) continue;
      const ev = /^\s{1,4}([A-Za-z]\w*):\s*$/.exec(raw);
      if (ev) event = ev[1]!;
      const loc = /^\s*-?\s*location:\s*["']?([^\s"']+)/.exec(raw);
      if (loc) hooks.set(loc[1]!.replace(/^\.\//, ''), `${name} ${event}`);
    }
  }
  return hooks;
}

const SERVER_PATH = /(?:^|[\s"'=:(])\/(?:var\/www|srv|opt|home\/ubuntu|etc)\//;

function scan(file: string, text: string, hooks: Map<string, string>): DeployHelper | null {
  const live = liveLines(text);
  const labels = branchLabels(live);
  const branchRoles = labels.map((l) => deployRole(l, true)).filter((r): r is NonNullable<typeof r> => !!r);
  const byName = deployRole(path.parse(file).name);
  const branchWhole = branchRoles.some((r) => r.role === 'deploy');
  const branchStep = branchRoles.find((r) => r.role === 'step');
  if (!branchRoles.length && !byName) return null;

  // A name that names the part wins: `deploy_migrations.sh` is a step even if it also answers to `deploy`.
  const role: 'deploy' | 'step' = byName?.role === 'step' ? 'step' : branchWhole ? 'deploy' : (byName?.role ?? 'step');
  const part = byName?.role === 'step' ? byName.part : !branchWhole ? (branchStep?.part ?? byName?.part) : undefined;

  const body = live.join('\n');
  const stub = !live.some((l) => !IDLE.test(l) && !ASSIGN.test(l) && !STRUCTURE.test(l));
  const local = /\bGWLOCAL\b/.test(body);
  const serverCommand = /\$\{?GWHOME\b|\bsystemctl\b|\bsudo\b/.test(body);
  const serverPath = SERVER_PATH.test(body);
  const serverOnly = !local && (serverCommand || serverPath);
  const hook = hooks.get(file);

  const rejections = [
    ...(role === 'step' ? [`one step of a deploy${part ? ` (${part})` : ''}, not a whole deploy`] : []),
    ...(hook ? [`a hook the platform runs on the server (${hook})`] : []),
    ...(stub ? ['does nothing: every command is commented out or only prints'] : []),
    ...(serverOnly ? ['needs the server, not this checkout'] : []),
  ];
  const reasons = [
    branchWhole ? 'has a "$1" = "d"/"deploy" branch' : byName ? 'named like a deploy script' : 'has a deploy-step branch',
    ...(role === 'step' ? [`one step of a deploy${part ? ` (${part})` : ''}`] : []),
    ...(hook ? [`a platform hook (${hook})`] : []),
    ...(stub ? ['does nothing'] : []),
    ...(local ? ['marked local (GWLOCAL)'] : []),
    ...(serverOnly ? [`uses ${serverCommand ? '$GWHOME, systemctl or sudo' : 'a server path'} (server only)`] : []),
  ];
  const eligible = rejections.length === 0;
  return {
    file,
    local,
    serverOnly,
    branch: branchWhole,
    role,
    ...(hook ? { hook } : {}),
    stub,
    eligible,
    ...(eligible ? {} : { rejected: rejections.join('; ') }),
    score: (local ? 10 : 0) - (serverOnly ? 5 : 0) + (branchWhole ? 3 : 0) + (byName ? 2 : 0) - (role === 'step' ? 4 : 0) - (hook ? 4 : 0) - (stub ? 4 : 0),
    reasons,
  };
}

/**
 * Executable scripts (with a shebang) directly in `root` that have a deploy entry point, eligible ones
 * first and the best candidate first. Hidden files, directories (a `deploy/` folder is not a command)
 * and big files are skipped. Callers offer only the `eligible` ones and report the rest with `rejected`.
 */
export function findDeployHelpers(root: string): DeployHelper[] {
  const found: DeployHelper[] = [];
  const hooks = platformHooks(root);
  for (const name of listDir(root)) {
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_BYTES || (st.mode & 0o111) === 0) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!text.startsWith('#!')) continue;
      const helper = scan(name, text, hooks);
      if (helper) found.push(helper);
    } catch {
      // unreadable: skip
    }
  }
  return found.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.file.localeCompare(b.file));
}
