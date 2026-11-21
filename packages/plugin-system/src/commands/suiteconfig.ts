import fs from 'node:fs';
import { userConfigPath } from '@pulpfixer/kit/config';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { ask } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, table, termLine } from '@pulpfixer/kit/ui/text';
import { SUITE_SETTINGS, SUITE_SETTING_KEYS, setSuiteSetting, shortHome, suiteSetting, suiteSettings, unsetSuiteSetting, type SettingValue } from '@pulpfixer/kit/suite-settings';

export const CONFIG_USAGE = `Usage:
  pf suite config [--json]               show the suite settings: value, default, where it comes from
  pf suite config get <key>              print the value in effect (resolved, for scripts)
  pf suite config set <key> [<value>]    save a setting (asks in a terminal when no value is given)
  pf suite config unset <key>            go back to the default
Settings: ${SUITE_SETTING_KEYS.join(', ')}`;

function problem(message: string, code: number): number {
  process.stderr.write(`${badgeLabel('error', err())} ${message}\n`);
  return code;
}

const SOURCE: Record<SettingValue['source'], string> = { env: 'environment', config: 'saved', default: 'default' };

function show(json: boolean): number {
  const rows = suiteSettings();
  if (json) {
    process.stdout.write(JSON.stringify({ file: userConfigPath(), settings: rows }, null, 2) + '\n');
    return 0;
  }
  const c = out();
  process.stdout.write(
    table(
      ['setting', 'value', 'from'],
      rows.map((r) => [c.bold(r.key), r.value + (r.resolved !== r.value ? c.dim(`  (${r.resolved})`) : ''), c.dim(SOURCE[r.source])]),
      c,
    ) + '\n',
  );
  for (const r of rows) process.stdout.write(`${c.dim(`${r.key}: ${r.description} (default ${r.default})`)}\n`);
  process.stdout.write(`${c.dim(`saved in ${userConfigPath()}  ·  change: `)}${termLine('pf suite config set <key> <value>', c)}\n`);
  return 0;
}

/** After saving a folder setting: say whether the folder is there yet. */
function folderNote(key: string): string {
  const v = suiteSetting(key);
  if (!v || key !== 'reposDir') return '';
  return fs.existsSync(v.resolved) ? '' : `${shortHome(v.resolved)} does not exist yet: it is created the first time a repo is made there`;
}

/** `pf suite config ...`: the args after `config`. */
export async function runSuiteConfig(args: string[], opts: { json: boolean }): Promise<number> {
  const [action = 'show', key, ...rest] = args;
  if (action === 'show' || action === 'list' || action === 'ls') {
    if (key !== undefined) return problem(`unexpected "${key}"\n${CONFIG_USAGE}`, 2);
    return show(opts.json);
  }
  if (action !== 'get' && action !== 'set' && action !== 'unset') return problem(`unknown config command "${action}"\n${CONFIG_USAGE}`, 2);
  if (!key) return problem(`which setting? (${SUITE_SETTING_KEYS.join(', ')})\n${CONFIG_USAGE}`, 2);
  if (!Object.hasOwn(SUITE_SETTINGS, key)) return problem(`no suite setting "${key}" (${SUITE_SETTING_KEYS.join(', ')})`, 2);
  const c = out();

  if (action === 'get') {
    if (rest.length) return problem(`unexpected "${rest.join(' ')}"\n${CONFIG_USAGE}`, 2);
    process.stdout.write(suiteSetting(key)!.resolved + '\n');
    return 0;
  }

  if (action === 'unset') {
    if (rest.length) return problem(`unexpected "${rest.join(' ')}"\n${CONFIG_USAGE}`, 2);
    const r = unsetSuiteSetting(key);
    if (!r.ok) return problem(r.error, r.kind === 'save' ? 1 : 2);
    const now = suiteSetting(key)!;
    process.stdout.write(`${c.green('✔')} ${key} is back to ${now.value}${now.source === 'env' ? c.dim(' (the environment still overrides it)') : ''}\n`);
    return 0;
  }

  let value = rest.length ? rest.join(' ') : undefined;
  if (value === undefined) {
    const def = SUITE_SETTINGS[key]!;
    const answer = await ask(`${key} (${def.description})`, {
      initial: suiteSetting(key)!.value,
      validate: (v) => {
        const n = def.normalize(v);
        return 'error' in n ? n.error : null;
      },
    });
    if (answer === null) return problem(`no value given: pf suite config set ${key} <value>`, 2);
    value = answer;
  }
  const r = setSuiteSetting(key, value);
  if (!r.ok) return problem(r.error, r.kind === 'save' ? 1 : 2);
  const now = suiteSetting(key)!;
  process.stdout.write(`${c.green('✔')} ${key} = ${r.value}${now.source === 'env' ? c.dim('  (the environment overrides it for now)') : ''}\n`);
  const note = folderNote(key);
  if (note) process.stdout.write(`  ${c.dim(note)}\n`);
  return 0;
}
