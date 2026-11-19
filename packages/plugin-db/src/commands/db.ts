import os from 'node:os';
import path from 'node:path';
import { dbDriver, dbDrivers, findForm, type ConnectionField, type ConnectionForm, type DbDriver } from '@pulpfixer/kit/db';
import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { ask, confirm } from '@pulpfixer/kit/ui/prompt';
import { badge, table, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { flagName, takeBool } from '../args.js';
import { driverFor, resolveParams } from '../client.js';
import { BUILTIN_DRIVERS, KNOWN_DRIVERS } from '../drivers/index.js';
import { DbError } from '../errors.js';
import {
  describeRef,
  keychain,
  keychainAccount,
  parseSecretRef,
  type SecretRef,
} from '../secrets.js';
import { checkName, getConnection, loadConnections, plainParams, putConnection, removeConnection, type Connection } from '../store.js';

export { KNOWN_DRIVERS };

const isBuiltin = (d: DbDriver) => BUILTIN_DRIVERS.some((b) => b.id === d.id);

type Value = string | number | boolean;

const say = (s: string) => process.stderr.write(s + '\n');
const fail = (msg: string, hint?: string): number => {
  const c = err();
  say(`${badge.error(msg, c)}${hint ? `\n  ${c.dim('try')} ${termLine(hint, c)}` : ''}`);
  return 1;
};
const usageError = (msg: string): number => {
  say(badge.error(msg, err()));
  return 2;
};

export type Parsed = { value: Value } | { error: string } | null;

/** Turn the text of one field into its value (null when empty), or say why not. */
export function parseField(f: ConnectionField, raw: string): Parsed {
  const s = raw.trim();
  if (s === '') return null;
  if (f.kind === 'number') return /^\d+$/.test(s) ? { value: Number(s) } : { error: `${f.label} must be a whole number` };
  if (f.kind === 'boolean') {
    if (/^(true|yes|y|1)$/i.test(s)) return { value: true };
    if (/^(false|no|n|0)$/i.test(s)) return { value: false };
    return { error: `${f.label} must be yes or no` };
  }
  if (f.kind === 'path') return { value: s === ':memory:' ? s : path.resolve(s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : s) };
  return { value: s };
}

function showList(args: string[]): number {
  const json = takeFlag(args, '--json');
  const conns = loadConnections();
  const names = Object.keys(conns).sort();
  if (json) {
    process.stdout.write(JSON.stringify(names.map((name) => ({ name, ...conns[name]! })), null, 2) + '\n');
    return 0;
  }
  const c = out();
  if (names.length === 0) {
    process.stdout.write(`${c.dim('No database connections yet.')}\n`);
    say(`${err().dim('Add one with')} ${termLine('pf db add', err())}`);
    return 0;
  }
  const rows = names.map((name) => {
    const conn = conns[name]!;
    const driver = dbDriver(conn.driver);
    let where = c.dim('(driver not installed)');
    if (driver) {
      try {
        where = driver.describe(conn.form, conn.params);
      } catch {
        where = c.dim('(unreadable)');
      }
    }
    const secrets = Object.entries(conn.secrets).map(([k, r]) => `${k}: ${describeRef(r)}`).join(', ');
    return [name, conn.driver, where, secrets || c.dim('none')];
  });
  process.stdout.write(table(['name', 'driver', 'connection', 'secrets'], rows, c) + '\n');
  return 0;
}

function showDrivers(): number {
  const c = out();
  const installed = dbDrivers();
  const rows = installed.map((d) => [d.id, d.dialect, d.label, d.forms.map((f) => f.id).join(', '), c.green(isBuiltin(d) ? 'built in' : 'installed')]);
  for (const k of KNOWN_DRIVERS) {
    if (!dbDriver(k.id)) rows.push([k.id, '', k.label, '', `pf plugin install db-${k.id}`]);
  }
  process.stdout.write(table(['driver', 'dialect', 'database', 'forms', 'status'], rows, c) + '\n');
  return 0;
}

/** Pick the driver from `--driver`, or ask. Returns a message (already printed) on failure. */
async function chooseDriver(id: string | undefined): Promise<DbDriver | number> {
  if (id) {
    const d = dbDriver(id);
    if (d) return d;
    const known = KNOWN_DRIVERS.some((k) => k.id === id);
    return fail(`the "${id}" database driver is not installed`, known ? `pf plugin install db-${id}` : `pf db drivers`);
  }
  const all = dbDrivers();
  if (all.length === 0) return fail('no database driver is installed', 'pf db drivers');
  const missing = KNOWN_DRIVERS.filter((k) => !dbDriver(k.id));
  if (!interactive()) {
    if (all.length === 1) return all[0]!;
    return usageError(`say which driver: pf db add <name> --driver ${all.map((d) => d.id).join('|')}`);
  }
  if (all.length === 1 && missing.length === 0) return all[0]!;
  const chosen = await pick<DbDriver | string>('Database driver', [
    ...all.map((d) => ({ value: d, label: d.id, hint: d.label })),
    ...missing.map((k) => ({ value: k.id, label: k.id, hint: `${k.label} (not installed)` })),
  ]);
  if (chosen === null) return (say(err().dim('cancelled')), 130);
  if (typeof chosen === 'string') return fail(`the "${chosen}" database driver is not installed`, `pf plugin install db-${chosen}`);
  return chosen;
}

/** The form to use: `--form`, else the one that fits the flags given, else ask (several) or the first. */
async function chooseForm(driver: DbDriver, id: string | undefined, given: Set<string>): Promise<ConnectionForm | number> {
  if (id) {
    const f = findForm(driver, id);
    return f ?? usageError(`driver "${driver.id}" has no form "${id}" (${driver.forms.map((x) => x.id).join(', ')})`);
  }
  if (driver.forms.length === 1) return driver.forms[0]!;
  const score = (f: ConnectionForm) => f.fields.filter((x) => given.has(x.key)).length;
  const best = Math.max(...driver.forms.map(score));
  if (best > 0) return driver.forms.find((f) => score(f) === best)!;
  if (!interactive()) return driver.forms[0]!;
  const chosen = await pick('How do you connect?', driver.forms.map((f) => ({ value: f, label: f.label, hint: f.fields.map((x) => x.key).join(', ') })));
  return chosen ?? (say(err().dim('cancelled')), 130);
}

async function askSecretRef(connName: string, f: ConnectionField): Promise<SecretRef | null | number> {
  const k = keychain();
  const items = [
    ...(k ? [{ value: 'keychain', label: `Save in ${k.label}`, hint: 'asked once, here' }] : []),
    { value: 'env', label: 'Read from an environment variable', hint: 'nothing is saved' },
    { value: 'prompt', label: 'Ask every time', hint: 'nothing is saved' },
    ...(f.required ? [] : [{ value: 'none', label: `No ${f.label.toLowerCase()}` }]),
  ];
  const choice = await pick(`Where does the ${f.label.toLowerCase()} come from?`, items);
  if (!choice) return (say(err().dim('cancelled')), 130);
  if (choice === 'none') return null;
  if (choice !== 'env') return { from: choice as 'keychain' | 'prompt' };
  const name = await ask('Environment variable name:', {
    initial: `PF_DB_${connName}_${f.key}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
    validate: (v) => (typeof parseSecretRef(`env:${v}`) === 'string' ? 'letters, digits and _ only' : null),
  });
  return name ? { from: 'env', name } : (say(err().dim('cancelled')), 130);
}

async function add(args: string[]): Promise<number> {
  const rest = [...args];
  const yes = takeFlag(rest, '--yes', '-y');
  const noTest = takeFlag(rest, '--no-test');
  const tty = interactive();
  const driver = await chooseDriver(takeOption(rest, '--driver'));
  if (typeof driver === 'number') return driver;
  const formOpt = takeOption(rest, '--form');
  const secretFrom = takeOption(rest, '--secret-from');

  // Field flags: take them for every form, since the form is chosen from what was given.
  const given: Record<string, string> = {};
  const seen = new Map<string, ConnectionField>();
  for (const form of driver.forms) for (const f of form.fields) if (!seen.has(f.key)) seen.set(f.key, f);
  for (const f of seen.values()) {
    if (f.kind === 'secret') continue;
    const flag = flagName(f.key);
    if (f.kind === 'boolean') {
      const b = takeBool(rest, flag);
      if (b !== undefined) given[f.key] = String(b);
    } else {
      const v = takeOption(rest, flag);
      if (v !== undefined) given[f.key] = v;
    }
  }
  for (const f of seen.values()) {
    if (f.kind === 'secret' && rest.some((a) => a === flagName(f.key) || a.startsWith(`${flagName(f.key)}=`))) {
      return usageError(`${f.label} is a secret: it is never taken from a flag. Use --secret-from env:NAME (or keychain, prompt)`);
    }
  }
  const stray = rest.filter((a) => a.startsWith('-'));
  if (stray.length) return usageError(`unknown option ${stray[0]} for the ${driver.id} driver. ${termLine('pf db add --help', err())}`);
  if (rest.length > 1) return usageError(`one name only (got ${rest.join(', ')})`);

  const form = await chooseForm(driver, formOpt, new Set(Object.keys(given)));
  if (typeof form === 'number') return form;

  let name = rest[0];
  if (!name) {
    if (!tty) return usageError('give the connection a name: pf db add <name> --driver ' + driver.id);
    const a = await ask('Name for this connection:', { initial: driver.id, validate: (v) => checkName(v) });
    if (!a) return (say(err().dim('cancelled')), 130);
    name = a;
  }
  const bad = checkName(name);
  if (bad) return usageError(`"${name}" is not a connection name: ${bad}`);

  if (getConnection(name) && !yes) {
    if (!(await confirm(`A connection named "${name}" exists. Replace it?`, false, { flag: '--yes' }))) return (say(err().dim('nothing changed')), 1);
  }

  // Plain values.
  const values: Record<string, Value> = {};
  const missing: string[] = [];
  for (const f of form.fields) {
    if (f.kind === 'secret') continue;
    let raw = given[f.key];
    if (raw === undefined && tty) {
      if (f.kind === 'boolean') {
        raw = String(await confirm(f.label + '?', f.default === true));
      } else {
        const a = await ask(`${f.label}${f.help ? ` (${f.help})` : ''}:`, {
          ...(f.default !== undefined ? { initial: String(f.default) } : {}),
          ...(f.placeholder ? { placeholder: f.placeholder } : {}),
          validate: (v) => {
            if (v === '') return f.required ? `${f.label} is required` : null;
            const p = parseField(f, v);
            return p && 'error' in p ? p.error : null;
          },
        });
        if (a === null) return (say(err().dim('cancelled')), 130);
        raw = a;
      }
    }
    raw ??= f.default !== undefined ? String(f.default) : undefined;
    if (raw === undefined || raw.trim() === '') {
      if (f.required) missing.push(`${flagName(f.key)} <${f.label.toLowerCase()}>`);
      continue;
    }
    const parsed = parseField(f, raw);
    if (parsed && 'error' in parsed) return usageError(parsed.error);
    if (parsed) values[f.key] = parsed.value;
  }
  if (missing.length) return usageError(`missing: ${missing.join(' ')}`);

  // Secrets: references only.
  const secrets: Record<string, SecretRef> = {};
  for (const f of form.fields) {
    if (f.kind !== 'secret') continue;
    let ref: SecretRef | null;
    if (secretFrom !== undefined) {
      const p = parseSecretRef(secretFrom);
      if (typeof p === 'string') return usageError(p);
      ref = p;
    } else if (tty) {
      const r = await askSecretRef(name, f);
      if (typeof r === 'number') return r;
      ref = r;
    } else if (f.required) {
      return usageError(`${f.label} is a secret: say where it comes from with --secret-from env:NAME`);
    } else {
      ref = null;
    }
    if (ref) secrets[f.key] = ref;
  }

  // Keychain secrets are entered here, in a terminal, by the keychain tool itself.
  const stored: string[] = [];
  const undo = () => {
    const k = keychain();
    for (const a of stored) k?.remove(a);
  };
  for (const [key, ref] of Object.entries(secrets)) {
    if (ref.from !== 'keychain') continue;
    const k = keychain();
    if (!k) return fail('the keychain is not available on this machine', `pf db add ${name} --secret-from env:NAME`);
    if (!tty) return fail('saving to the keychain needs a terminal', `pf db add ${name} --secret-from env:NAME`);
    const account = keychainAccount(name, key);
    say(err().dim(`${k.label} will ask for the ${key}:`));
    if (!k.store(account)) {
      undo();
      return fail(`could not save the ${key} in ${k.label}`);
    }
    stored.push(account);
  }

  const conn: Connection = { driver: driver.id, form: form.id, params: plainParams(form, values), secrets };

  if (!noTest) {
    const needsPrompt = Object.values(secrets).some((r) => r.from === 'prompt');
    if (needsPrompt && !tty) {
      say(err().dim('connection not tested (a secret is asked for each time, and there is no terminal)'));
    } else {
      try {
        const ms = await testConnection(name, conn);
        say(`${err().green('✓')} connected ${err().dim(`(${ms} ms)`)}`);
      } catch (e) {
        say(badge.error(`could not connect: ${(e as Error).message}`, err()));
        if (!(tty && (await confirm('Save the connection anyway?', false)))) {
          undo();
          say(err().dim('not saved. Fix the values, or skip the check with --no-test'));
          return 1;
        }
      }
    }
  }

  try {
    putConnection(name, conn);
  } catch (e) {
    undo();
    return fail((e as Error).message);
  }
  say(`${err().green('✓')} saved connection ${err().bold(name)} ${err().dim(`(${driver.describe(conn.form, conn.params)})`)}`);
  say(`${err().dim('Test it with')} ${termLine(`pf db test ${name}`, err())}`);
  return 0;
}

/** Connect, run `SELECT 1`, close. Returns how long it took. Throws what the driver throws. */
export async function testConnection(name: string, conn: Connection): Promise<number> {
  const driver = driverFor(conn.driver);
  const params = await resolveParams(name, conn, driver);
  const started = Date.now();
  const session = await driver.connect(conn.form, params);
  try {
    await session.execute({ text: 'SELECT 1', values: [] });
  } finally {
    await session.close().catch(() => undefined);
  }
  return Date.now() - started;
}

async function remove(args: string[]): Promise<number> {
  const rest = [...args];
  const yes = takeFlag(rest, '--yes', '-y');
  const name = rest[0];
  if (!name) return usageError('say which connection: pf db remove <name>');
  const conn = getConnection(name);
  if (!conn) return fail(`there is no connection "${name}"`, 'pf db list');
  const keys = Object.entries(conn.secrets).filter(([, r]) => r.from === 'keychain');
  const extra = keys.length ? ` and its ${keys.map(([k]) => k).join(', ')} in the keychain` : '';
  if (!yes && !(await confirm(`Remove connection "${name}"${extra}?`, false, { flag: '--yes' }))) {
    say(err().dim('nothing removed'));
    return 1;
  }
  removeConnection(name);
  const k = keychain();
  for (const [key] of keys) k?.remove(keychainAccount(name, key));
  say(`${err().green('✓')} removed ${name}`);
  return 0;
}

async function test(args: string[]): Promise<number> {
  const rest = [...args];
  let name = rest[0];
  const conns = loadConnections();
  if (!name) {
    const names = Object.keys(conns);
    if (names.length === 1) name = names[0]!;
    else return usageError(names.length ? `which one? pf db test <${names.join('|')}>` : 'there are no connections: pf db add');
  }
  const conn = conns[name];
  if (!conn) return fail(`there is no connection "${name}"`, 'pf db list');
  try {
    const ms = await testConnection(name, conn);
    say(`${err().green('✓')} ${name} works ${err().dim(`(${ms} ms)`)}`);
    return 0;
  } catch (e) {
    return fail(`${name}: ${(e as Error).message}`, e instanceof DbError ? e.hint : undefined);
  }
}

export const dbCommand: Command = {
  name: 'db',
  summary: 'Database connections: list, add, remove, test',
  group: 'Tools',
  usage: 'pf db [list|add|remove|test|drivers]',
  async run(_ctx, args) {
    const rest = [...args];
    const sub = rest.shift() ?? 'list';
    try {
      if (sub === 'list' || sub === 'ls') return showList(rest);
      if (sub === 'add') return await add(rest);
      if (sub === 'remove' || sub === 'rm') return await remove(rest);
      if (sub === 'test') return await test(rest);
      if (sub === 'drivers') return showDrivers();
    } catch (e) {
      if (e instanceof DbError) return fail(e.message, e.hint);
      throw e;
    }
    return usageError(`unknown subcommand "${sub}". ${termLine(dbCommand.usage, err())}`);
  },
};
