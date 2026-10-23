import { err } from '@pulpfixer/kit/ui/palette';
import { multiPick, pick } from '@pulpfixer/kit/ui/picker';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';
import { installPlugins, listAvailable, listPlugins, removePlugins, updatePlugins } from '../plugins/manage.js';
import { installedPlugins, searchRemote } from '../plugins/registry.js';

type Action = 'list' | 'available' | 'install' | 'update' | 'remove';

const ALIASES: Record<string, Action> = {
  ls: 'list',
  search: 'available',
  add: 'install',
  upgrade: 'update',
  rm: 'remove',
  uninstall: 'remove',
};

/** Interactive administration: choose an action, then the plugins it applies to. */
async function adminMenu(dryRun: boolean): Promise<number> {
  const action = await pick<Action>('Plugins', [
    { value: 'list', label: 'List', hint: 'built-in and installed plugins' },
    { value: 'available', label: 'Available', hint: 'built-in and registry plugins, with versions' },
    { value: 'install', label: 'Install', hint: 'pick from the registry' },
    { value: 'update', label: 'Update', hint: 'bring installed plugins to the latest' },
    { value: 'remove', label: 'Remove', hint: 'delete installed plugins' },
  ]);
  if (!action) return 130;
  const c = err();
  if (action === 'list') return listPlugins();
  if (action === 'available') return listAvailable();
  if (action === 'update') return updatePlugins([], { dryRun });
  if (action === 'install') {
    const found = searchRemote();
    if (!found.plugins) {
      process.stderr.write(`${badgeLabel('error', c)} could not search the registry: ${found.error}\n`);
      return 1;
    }
    const have = new Set(installedPlugins().map((p) => p.name));
    const items = found.plugins.filter((p) => !have.has(p.name)).map((p) => ({ value: p.name, label: p.name, hint: p.description }));
    if (!items.length) {
      process.stderr.write('Every plugin on the registry is installed already.\n');
      return 0;
    }
    const chosen = await multiPick('Install plugins', items, { search: true });
    if (!chosen?.length) return 130;
    process.stderr.write(`${c.dim('same without the menu:')} ${termLine(`pf plugin install ${chosen.join(' ')}`, c)}\n`);
    return installPlugins(chosen, { dryRun });
  }
  const items = installedPlugins().map((p) => ({ value: p.name, label: p.name, hint: p.package }));
  if (!items.length) {
    process.stderr.write('No plugins installed from the registry.\n');
    return 0;
  }
  const chosen = await multiPick('Remove plugins', items);
  if (!chosen?.length) return 130;
  process.stderr.write(`${c.dim('same without the menu:')} ${termLine(`pf plugin remove ${chosen.join(' ')}`, c)}\n`);
  return removePlugins(chosen, { dryRun });
}

export const pluginCommand: Command = {
  name: 'plugin',
  summary: 'Install, update and remove plugins',
  group: 'Tools',
  usage: 'pf plugin [list | available | install <name[@version]...> | update [name...] [--check] | remove <name...>] [--dry-run]',
  async run(_ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const check = takeFlag(rest, '--check');
    const c = err();
    const unknownFlag = rest.find((a) => a.startsWith('-'));
    if (unknownFlag) {
      process.stderr.write(`${badgeLabel('error', c)} unknown option ${unknownFlag}\n`);
      return 1;
    }
    const first = rest.shift();
    if (!first) return interactive() ? adminMenu(dryRun) : listPlugins();
    const sub = (ALIASES[first] ?? first) as Action;
    if (sub === 'list') return listPlugins();
    if (sub === 'available') return listAvailable();
    if (sub === 'update') return updatePlugins(rest, { check, dryRun });
    if (sub === 'install' || sub === 'remove') {
      if (!rest.length) {
        process.stderr.write(`${badgeLabel('error', c)} name the plugins: ${termLine(`pf plugin ${sub} <name...>`, c)}${sub === 'install' ? ` (${termLine('pf plugin available', c)} lists them)` : ''}\n`);
        return 1;
      }
      return sub === 'install' ? installPlugins(rest, { dryRun }) : removePlugins(rest, { dryRun });
    }
    process.stderr.write(`${badgeLabel('error', c)} unknown subcommand "${first}". Try: list, available, install, update, remove\n`);
    return 1;
  },
};
