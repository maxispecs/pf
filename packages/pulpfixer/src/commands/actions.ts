import { ICON_NAME, setRepoConfigSection } from '@pulpfixer/kit/config';
import type { Context } from '@pulpfixer/kit/context';
import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { takeFlag, takeOption } from '@pulpfixer/kit/util';
import { buildStack, version } from '@pulpfixer/kit/version';
import { defaultMeta } from '../actionmeta.js';
import { entriesFor } from '../menu.js';

/** One thing the repo can do, as `pf actions --json` lists it (editors draw the featured ones as buttons). */
export interface ActionInfo {
  /** Stable id: `dev`, `deploy:staging`, `install:local`, a custom command's name. Keys the `actions` section of pulpfixer.json. */
  id: string;
  /** Short name for a tooltip: "Deploy to staging". */
  label: string;
  summary: string;
  group: string;
  /** Codicon name. */
  icon: string;
  featured: boolean;
  /** Conditions that must all hold for an editor to show its button (`changes`, `unpushed`, `pfBehind`); empty: always. */
  when: string[];
  /** The pf arguments that run it (`pf deploy staging`). */
  argv: string[];
}

/** The pf that printed the document: an editor compares `stack` with the repo's `versions.json` (the `pfBehind` condition). */
export interface PfInfo {
  version: string;
  /** The stack version this pf was built from; null for a build with no stamp. */
  stack: string | null;
}

/** Bump when a field of `ActionInfo` changes meaning; the JSON carries it so a client can refuse a newer shape. */
export const ACTIONS_SCHEMA = 1;

/**
 * Every action the repo has, with the repo's overrides applied (`actions` in pulpfixer.json beats a custom
 * command's own `icon` / `featured`, which beat the defaults). Empty outside a repo.
 */
export function listActions(ctx: Context): ActionInfo[] {
  if (!ctx.repo) return [];
  const list: ActionInfo[] = [];
  for (const e of entriesFor(ctx)) {
    if (!e.id || !e.argv) continue;
    const over = ctx.config.actions?.[e.id];
    const cfg = ctx.config.commands[e.id];
    const d = defaultMeta(e.id);
    list.push({
      id: e.id,
      // A custom command with no description has its command line as summary: the name is the better tooltip.
      label: cfg && !cfg.description && e.summary === cfg.run ? e.id : e.summary,
      summary: e.summary,
      group: e.group,
      icon: over?.icon ?? e.icon ?? d.icon,
      featured: over?.featured ?? e.featured ?? d.featured,
      // `e.when` already holds a custom command's own `when`, else the default.
      when: over?.when ?? e.when ?? d.when ?? [],
      argv: e.argv,
    });
  }
  return list;
}

/** The JSON document `pf actions --json` prints. */
export function actionsDocument(
  ctx: Context,
  all: boolean,
  pf: PfInfo = { version: version(), stack: buildStack() },
): { schema: number; repo: string | null; pf: PfInfo; actions: ActionInfo[] } {
  const actions = listActions(ctx);
  return { schema: ACTIONS_SCHEMA, repo: ctx.repo?.name ?? null, pf, actions: all ? actions : actions.filter((a) => a.featured) };
}

const w = (s: string) => process.stdout.write(s + '\n');
const fail = (msg: string) => {
  process.stderr.write(`${badgeLabel('error', err())} ${msg}\n`);
  return 1;
};

/** The footer of the table: the pf that listed the actions and the stack it was built from. */
export function pfLine(pf: PfInfo): string {
  return `pf ${pf.version}, stack ${pf.stack ?? 'unknown (a build with no stamp)'}`;
}

function printTable(ctx: Context, all: boolean): number {
  const c = out();
  const doc = actionsDocument(ctx, all);
  const actions = doc.actions;
  if (!ctx.repo) return fail('pf actions needs a repo. Run it inside a project directory.');
  if (!actions.length) {
    w(`No ${all ? '' : 'featured '}actions in ${ctx.repo.name}.${all ? '' : ` ${termLine('pf actions --all', c)} lists every action.`}`);
    w(c.dim(pfLine(doc.pf)));
    return 0;
  }
  const idW = Math.max(...actions.map((a) => a.id.length));
  const iconW = Math.max(...actions.map((a) => a.icon.length));
  w(`${c.bold(ctx.repo.name)}  ${c.dim(all ? 'every action; * = featured (a button)' : 'featured actions (a button each)')}`);
  for (const a of actions) {
    w(`  ${a.featured ? '*' : ' '} ${c.bold(a.id.padEnd(idW))}  ${c.dim(a.icon.padEnd(iconW))}  ${a.summary}  ${c.dim(`pf ${a.argv.join(' ')}`)}${a.when.length ? c.dim(`  (when ${a.when.join(' + ')})`) : ''}`);
  }
  w(c.dim(pfLine(doc.pf)));
  return 0;
}

/** Set `featured` (and optionally `icon`) for the given ids in the `actions` section of pulpfixer.json. */
export function setFeatured(ctx: Context, ids: string[], featured: boolean, opts: { icon?: string; dryRun?: boolean } = {}): number {
  if (!ctx.repo) return fail('pf actions needs a repo. Run it inside a project directory.');
  if (!ids.length) return fail(`name the action(s): pf actions ${featured ? 'feature' : 'unfeature'} <id...>. pf actions --all lists them.`);
  if (opts.icon !== undefined && !ICON_NAME.test(opts.icon)) return fail(`"${opts.icon}" is not a codicon name (lowercase letters, digits and dashes, e.g. cloud-upload).`);
  const known = new Map(listActions(ctx).map((a) => [a.id, a]));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return fail(`no such action: ${unknown.join(', ')}. Known: ${[...known.keys()].join(', ') || 'none'}.`);
  const values: Record<string, unknown> = {};
  for (const id of ids) values[id] = { ...(ctx.config.actions?.[id] ?? {}), featured, ...(opts.icon ? { icon: opts.icon } : {}) };
  const r = setRepoConfigSection(ctx.repo.root, 'actions', values, { dryRun: opts.dryRun });
  if (!r.ok) return fail(r.error);
  const c = err();
  const verb = featured ? 'featured' : 'unfeatured';
  process.stderr.write(
    r.changed
      ? `${opts.dryRun ? 'would set' : 'set'} ${ids.map((i) => c.bold(i)).join(', ')} ${verb} in pulpfixer.json\n`
      : `${ids.map((i) => c.bold(i)).join(', ')} already ${verb}\n`,
  );
  return 0;
}

export const actionsCommand: Command = {
  name: 'actions',
  summary: 'List the repo actions editors show as buttons, and choose which are featured',
  group: 'Tools',
  usage: 'pf actions [--all] [--json] | pf actions feature|unfeature <id...> [--icon <codicon>] [--dry-run]',
  async run(ctx, args) {
    const rest = [...args];
    const json = takeFlag(rest, '--json');
    const all = takeFlag(rest, '--all', '-a');
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const icon = takeOption(rest, '--icon');
    const [sub, ...ids] = rest;
    if (sub === 'feature' || sub === 'unfeature') return setFeatured(ctx, ids, sub === 'feature', { icon, dryRun });
    if (sub) return fail(`unknown argument "${sub}". Usage: ${actionsCommand.usage}`);
    if (json) {
      w(JSON.stringify(actionsDocument(ctx, all)));
      return 0;
    }
    return printTable(ctx, all);
  },
};
