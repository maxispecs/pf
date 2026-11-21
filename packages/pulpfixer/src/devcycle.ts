import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_NAME, REGISTRY_URL } from '@pulpfixer/kit/constants';
import { capture, runCmd, type Cmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { ask, confirm, reporter } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { compareVersions, readJson, takeFlag, takeOption } from '@pulpfixer/kit/util';

/**
 * The dev cycle for working on pf itself (menu entry `cycle` of `./pf`):
 * bump what changed, commit, publish to cellars staging, then `pf u` so the global pf takes the new version.
 */

export interface CyclePackage {
  name: string;
  /** Path under the repo root, e.g. `packages/kit`. */
  rel: string;
  /** Version in the package's package.json. */
  local: string;
  /** Latest version on the registry, or null when it could not be read (or the package is not published yet). */
  published: string | null;
  /** Files changed since the package's last version bump. */
  changes: string[];
}

export interface PlannedBump {
  pkg: CyclePackage;
  reason: string;
}

/** Tests and docs do not ship, so changing them never needs a new version. */
export function shipsChange(file: string): boolean {
  return !/(^|\/)tests?\//.test(file) && !/\.test\.[cm]?[jt]s$/.test(file) && !/\.md$/i.test(file);
}

/**
 * A package fetched live at its latest version, so core does not pin it: a preset (`@pulpfixer/preset-<name>`,
 * data), a template (`@pulpfixer/template-<name>`, data), a suite extension (`@pulpfixer/ext-<name>`, a `.vsix`)
 * or a database driver (`@pulpfixer/db-<name>`) or an IO adapter (`@pulpfixer/io-<name>`), registry plugins installed
 * with `pf plugin install`.
 */
export const isPreset = (p: Pick<CyclePackage, 'name'>): boolean => ['preset-', 'ext-', 'db-', 'io-', 'template-'].some((k) => p.name.startsWith(`@pulpfixer/${k}`));

/** True when the package has a published version that is current with its package.json and changed since. */
function needsBump(p: CyclePackage): boolean {
  return p.published !== null && compareVersions(p.local, p.published) === 0 && p.changes.some(shipsChange);
}

/** True when the package.json version is already ahead of the registry (bumped, not published yet). */
export function isAhead(p: CyclePackage): boolean {
  return p.published !== null && compareVersions(p.local, p.published) > 0;
}

/**
 * Which packages need a minor bump before publishing: the ones with shipped changes since their last
 * published version. core pins its dependencies to exact versions and users only update core, so it
 * goes along with any bumped dependency unless it is already ahead of the registry. Presets
 * (`@pulpfixer/preset-*`), suite extensions (`@pulpfixer/ext-*`), database drivers (`@pulpfixer/db-*`) and IO adapters (`@pulpfixer/io-*`) are
 * fetched at their latest version, so core does not pin them and a change to one never drags core along.
 */
export function planBumps(pkgs: CyclePackage[]): PlannedBump[] {
  const plan: PlannedBump[] = pkgs.filter(needsBump).map((pkg) => ({ pkg, reason: 'changed since its last published version' }));
  const core = pkgs.find((p) => p.name === PACKAGE_NAME);
  const pinned = (p: CyclePackage) => p !== core && !isPreset(p);
  const anyAhead = pkgs.some((p) => pinned(p) && isAhead(p));
  const depChanged = plan.some((b) => pinned(b.pkg)) || anyAhead;
  if (core && depChanged && !plan.some((b) => b.pkg === core) && !isAhead(core) && core.published !== null) {
    plan.push({ pkg: core, reason: 'pins the packages that change, and users only update core' });
  }
  return plan;
}

/** Packages `pnpm run publish:cellars` would publish once the planned bumps are applied. */
export function publishable(pkgs: CyclePackage[], bumps: PlannedBump[]): CyclePackage[] {
  return pkgs.filter((p) => bumps.some((b) => b.pkg === p) || isAhead(p) || p.published === null);
}

const git = (root: string, ...args: string[]) => capture(['git', ...args], { cwd: root });

/** Files under `rel` that changed since the commit that last changed the package's version (committed or not). */
export function changesSinceBump(root: string, rel: string): string[] {
  const bump = git(root, 'log', '-1', '--format=%H', '-G', '"version"', '--', `${rel}/package.json`).stdout.trim();
  if (!bump) return [];
  const tracked = git(root, 'diff', '--name-only', bump, '--', rel).stdout;
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '--', rel).stdout;
  return [...new Set(`${tracked}\n${untracked}`.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** Latest version of a package on the registry, or null. Runs outside the repo so its .npmrc does not shadow the user's. */
export function publishedVersion(name: string): string | null {
  const r = capture(['npm', 'view', name, 'version', '--registry', REGISTRY_URL], { cwd: os.tmpdir(), timeout: 20_000 });
  const v = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  return r.ok && /^\d+\.\d+/.test(v) ? v : null;
}

/** Every publishable package in the checkout, with its registry version and what changed since its last bump. */
export function readPackages(root: string): CyclePackage[] {
  const dir = path.join(root, 'packages');
  const found: CyclePackage[] = [];
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const rel = `packages/${entry}`;
    const pkg = readJson<{ name?: string; version?: string; private?: boolean }>(root, rel, 'package.json');
    if (!pkg?.name || !pkg.version || pkg.private) continue;
    found.push({ name: pkg.name, rel, local: pkg.version, published: publishedVersion(pkg.name), changes: changesSinceBump(root, rel) });
  }
  return found;
}

/** `git status --short` lines. */
function dirtyFiles(root: string): string[] {
  return git(root, 'status', '--short').stdout.split('\n').filter((l) => l.trim());
}

/** Stack version from versions.json (`2.9`), for the default commit message. */
function stackVersion(root: string): string | null {
  return readJson<{ stack?: { version?: string } }>(root, 'versions.json')?.stack?.version ?? null;
}

/**
 * A commit message drafted from `git status --short` lines, e.g. `v2.9: update core (devcycle, cycle), kit (text)`.
 * Names the packages and files touched (version bookkeeping files are skipped); the user can edit it in the prompt.
 */
export function suggestCommitMessage(statusLines: string[], stack: string | null): string {
  const entries = statusLines
    .map((l) => ({ code: l.slice(0, 2).trim(), file: (l.slice(3).split(' -> ').pop() ?? '').trim().replace(/^"|"$/g, '') }))
    .filter((e) => e.file);
  const bookkeeping = (f: string) => f === 'versions.json' || /^packages\/[^/]+\/package\.json$/.test(f) || f === 'pnpm-lock.yaml';
  const real = entries.filter((e) => !bookkeeping(e.file));
  const prefix = stack ? `v${stack}` : '';
  if (!real.length) return prefix;

  const groups = new Map<string, Set<string>>();
  for (const { file } of real) {
    const parts = file.split('/');
    const area = parts[0] === 'packages' && parts.length > 2 ? parts[1]! : parts.length > 1 ? parts[0]! : 'root';
    const base = (parts.at(-1) ?? file).replace(/\.(test\.)?[cm]?[jt]sx?$|\.[a-z]+$/i, '');
    (groups.get(area) ?? groups.set(area, new Set()).get(area)!).add(base);
  }
  const areas = [...groups].map(([area, names]) => {
    const list = [...names];
    const shown = list.slice(0, 3).join(', ');
    return `${area} (${shown}${list.length > 3 ? `, +${list.length - 3}` : ''})`;
  });
  const shownAreas = areas.slice(0, 3).join(', ') + (areas.length > 3 ? `, +${areas.length - 3} more` : '');
  const verb = real.every((e) => e.code === '??' || e.code === 'A') ? 'add' : real.every((e) => e.code === 'D') ? 'remove' : 'update';
  return `${prefix ? `${prefix}: ` : ''}${verb} ${shownAreas}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until the registry serves `version` of pf, so `pf u` does not run against a stale answer. */
async function waitForRegistry(version: string, tries = 15): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const v = publishedVersion(PACKAGE_NAME);
    if (v && compareVersions(v, version) >= 0) return true;
    await sleep(2000);
  }
  return false;
}

/**
 * The pulpfixer checkout that `dir` is in (or below), else null. Lets the global `pf` run the dev cycle
 * from a checkout without the `./pf` launcher.
 */
export function findCheckout(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    const core = readJson<{ name?: string }>(path.join(cur, 'packages', 'pulpfixer', 'package.json'));
    if (core?.name === PACKAGE_NAME && fs.existsSync(path.join(cur, 'pf')) && fs.existsSync(path.join(cur, 'scripts', 'release.mjs'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export const CYCLE_USAGE = './pf cycle [--message <msg>] [--no-push] [--yes] [--dry-run]';

/** Run the whole cycle. Returns the exit code. */
export async function runDevCycle(root: string, args: string[] = []): Promise<number> {
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const yes = takeFlag(rest, '--yes', '-y');
  const push = !takeFlag(rest, '--no-push');
  const message = takeOption(rest, '--message') ?? takeOption(rest, '-m');
  const c = err();
  const r = reporter(out());
  const fail = (m: string, code = 1) => {
    process.stderr.write(`${badgeLabel('error', c)} ${m}\n`);
    return code;
  };

  if (!fs.existsSync(path.join(root, '.git'))) return fail(`${root} is not a git checkout.`);

  r.step('Versions');
  const pkgs = readPackages(root);
  const unknown = pkgs.filter((p) => p.published === null);
  if (unknown.length) r.warn(`could not read the registry for ${unknown.map((p) => p.name).join(', ')} (offline, or no token): not bumping those automatically`);
  const bumps = planBumps(pkgs);
  for (const p of pkgs) {
    const bump = bumps.find((b) => b.pkg === p);
    const shipped = p.changes.filter(shipsChange).length;
    if (bump) r.ok(`${p.name} ${p.local} -> bump minor (${bump.reason}${shipped ? `, ${shipped} file(s)` : ''})`);
    else if (isAhead(p)) r.ok(`${p.name} ${p.local} is ahead of the registry (${p.published}): to publish`);
    else r.info(`${p.name} ${p.local}: ${p.published === null ? 'registry unknown' : 'unchanged since it was published'}`);
  }
  const toPublish = publishable(pkgs, bumps);
  const dirty = dirtyFiles(root);
  const willCommit = dirty.length > 0 || bumps.length > 0;

  const steps: string[] = [];
  if (bumps.length) steps.push(`pnpm ver bump ${bumps.map((b) => `${b.pkg.rel} minor`).join(' ')}`);
  if (willCommit) steps.push(`git commit  ${dirty.length ? `(${dirty.length} changed file(s) now${bumps.length ? ', plus the bump' : ''})` : '(the bump)'}`);
  if (toPublish.length) steps.push(`pnpm run publish:cellars  (${toPublish.map((p) => p.name).join(', ')})`);
  if (push) steps.push('pf git push  (the primary remote, then the backups; --no-push skips)');
  steps.push('pf u --yes  (update the global pf)');

  process.stderr.write(`\n${c.bold('Dev cycle')} ${c.dim(`(${REGISTRY_URL})`)}\n`);
  steps.forEach((s, i) => process.stderr.write(`  ${c.dim(`${i + 1}.`)} ${termLine(s, c)}\n`));
  if (dryRun) {
    process.stderr.write(c.dim('dry run: nothing was changed\n'));
    return 0;
  }
  if (!yes) {
    if (!process.stdin.isTTY) return fail('refusing to publish without a terminal. Pass --yes to confirm, or --dry-run to preview.', 2);
    if (!(await confirm('Run the cycle? Publishing cannot be undone.', false, { flag: '--yes' }))) {
      process.stderr.write(c.dim('cancelled\n'));
      return 130;
    }
  }

  const run = (cmd: Cmd) => runCmd({ cwd: root, ...cmd }, { base: root });

  if (bumps.length) {
    r.step('Bump versions');
    const code = await run({ argv: ['pnpm', 'ver', 'bump', ...bumps.flatMap((b) => [b.pkg.rel, 'minor'])] });
    if (code !== 0) return fail('pnpm ver bump failed', code);
  }

  const pending = dirtyFiles(root);
  if (pending.length) {
    r.step('Commit');
    for (const l of pending.slice(0, 15)) r.info(l);
    if (pending.length > 15) r.info(`... and ${pending.length - 15} more`);
    const suggested = suggestCommitMessage(pending, bumps.length ? stackVersion(root) : null);
    let msg = message ?? (await ask('Commit message (empty skips the commit)', { initial: suggested, placeholder: 'what changed' }));
    if (msg === null && !message) {
      if (process.stdin.isTTY) {
        process.stderr.write(c.dim('cancelled\n'));
        return 130;
      }
      return fail('no commit message and no terminal. Pass --message <msg>.', 2);
    }
    msg = (msg ?? '').trim();
    if (!msg) r.warn('skipping the commit: the publish continues with these changes uncommitted');
    else {
      if ((await run({ argv: ['git', 'add', '-A'] })) !== 0) return fail('git add failed');
      const code = await run({ argv: ['git', 'commit', '-m', msg] });
      if (code !== 0) return fail('git commit failed', code);
    }
  }

  if (toPublish.length) {
    r.step('Publish to cellars staging');
    const code = await run({ argv: ['pnpm', 'run', 'publish:cellars'] });
    if (code !== 0) return fail('publish failed: fix it and run the cycle again (nothing after this step ran)', code);
  } else {
    r.step('Publish');
    r.info('nothing new to publish');
  }

  // A failed push never stops the update: the publish already happened. It still makes the cycle exit non-zero.
  let pushCode = 0;
  if (push) {
    r.step('Push to the repos');
    pushCode = await run({ argv: ['pf', 'git', 'push'] });
    if (pushCode !== 0) r.warn('pf git push failed: run it again after the update (the rest of the cycle continues)');
  }

  r.step('Update the global pf');
  const core = readJson<{ version?: string }>(root, 'packages', 'pulpfixer', 'package.json')?.version;
  if (toPublish.length && core && !(await waitForRegistry(core))) {
    r.warn(`the registry does not serve pulpfixer ${core} yet: pf u may report it is current. Run it again in a moment.`);
  }
  const code = await runCmd({ argv: ['pf', 'u', '--yes'], cwd: root });
  if (code !== 0) return fail('pf u failed', code);
  if (pushCode !== 0) return fail('published and updated, but the push failed', pushCode);
  r.ok('done');
  return 0;
}
