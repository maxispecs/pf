import type { Command } from '@pulpfixer/kit/types';
import { err, out, type Palette } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { reposDir, shortHome } from '@pulpfixer/kit/suite-settings';
import { enableFeatures, featureStatuses, loadSuite, type FeatureState, type FeatureStatus } from '../suite.js';
import { runSuiteConfig } from './suiteconfig.js';

const USAGE = `Usage:
  pf suite [list] [--json] [--offline]   the suite's features: what is on, what is optional
  pf suite enable [<feature>...] [--vault <path|name>] [--yes] [--dry-run] [--offline]
                                         turn features on (with no name: the default ones, not the optional ones)
  pf suite config [get|set|unset <key> [<value>]] [--json]
                                         the suite's settings (where new repos go)`;

const STATE_LABEL: Record<FeatureState, string> = { on: 'on', partial: 'partial', off: 'off', unavailable: 'n/a' };

function paint(state: FeatureState, text: string, c: Palette): string {
  return state === 'on' ? c.green(text) : state === 'partial' ? c.yellow(text) : c.dim(text);
}

function printList(rows: FeatureStatus[], c: Palette): void {
  const w = (s: string) => process.stdout.write(s + '\n');
  const width = Math.max(8, ...rows.map((r) => r.feature.id.length));
  w('');
  w(c.bold('Features') + c.dim('  default ones come with `pf suite enable`, optional ones only when named'));
  for (const r of rows) {
    const kind = r.feature.optional ? c.yellow('optional') : c.dim('default ');
    w(`  ${c.bold(r.feature.id.padEnd(width))}  ${paint(r.state, STATE_LABEL[r.state].padEnd(7), c)}  ${kind}  ${r.feature.summary}`);
    w(`  ${' '.repeat(width)}  ${c.dim(r.detail)}`);
  }
}

async function listSuite(o: { json: boolean; offline: boolean }): Promise<number> {
  const got = loadSuite(o.offline, o.json);
  if (!got) return 1;
  const rows = featureStatuses(got.suite);
  if (o.json) {
    process.stdout.write(
      JSON.stringify(
        {
          package: '@pulpfixer/suite',
          version: got.version,
          features: rows.map((r) => ({ ...r.feature, state: r.state, detail: r.detail })),
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  const c = out();
  printList(rows, c);
  process.stdout.write(`\n${c.dim(`new repos go in ${shortHome(reposDir())}  (`)}${termLine('pf suite config', c)}${c.dim(')')}\n`);
  if (!interactive()) {
    process.stdout.write(`\n${c.dim('enable:')} ${termLine('pf suite enable <feature>', c)}\n`);
    return 0;
  }
  // In a terminal, offer to enable one right away.
  const chosen = await pick(
    'Enable a feature?  (esc to leave)',
    rows.map((r) => ({
      value: r.feature.id,
      label: r.feature.id,
      hint: `${STATE_LABEL[r.state]}${r.feature.optional ? ', optional' : ''}: ${r.feature.summary}`,
      detail: r.detail,
      ...(r.state === 'unavailable' ? { disabled: r.detail } : {}),
    })),
  );
  if (!chosen) return 0;
  return enableFeatures([chosen], { offline: o.offline });
}

export const suiteCommand: Command = {
  name: 'suite',
  summary: 'List, enable and configure the pulpfixer suite: Cursor setup, optional Obsidian',
  group: 'Tools',
  usage: 'pf suite [list [--json] [--offline] | enable [<feature>...] [--vault <path|name>] [--yes] [--dry-run] [--offline] | config [get|set|unset <key> [<value>]] [--json]]',
  async run(_ctx, args) {
    const rest = [...args];
    const json = takeFlag(rest, '--json');
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const yes = takeFlag(rest, '--yes', '-y');
    const offline = takeFlag(rest, '--offline');
    const hadVault = rest.includes('--vault');
    const vault = takeOption(rest, '--vault');
    if (hadVault && vault === undefined) {
      process.stderr.write(`${badgeLabel('error', err())} --vault needs a path or a vault name\n${USAGE}\n`);
      return 2;
    }
    const sub = rest.shift() ?? 'list';
    if (sub === 'config') return runSuiteConfig(rest, { json });
    const unknownFlag = rest.find((a) => a.startsWith('-'));
    if (unknownFlag) {
      process.stderr.write(`${badgeLabel('error', err())} unknown option ${unknownFlag}\n${USAGE}\n`);
      return 2;
    }
    if (sub === 'list' || sub === 'ls') return listSuite({ json, offline });
    if (sub === 'enable') return enableFeatures(rest, { yes, dryRun, offline, ...(vault !== undefined ? { vault } : {}) });
    process.stderr.write(`${badgeLabel('error', err())} unknown subcommand "${sub}"\n${USAGE}\n`);
    return 2;
  },
};
