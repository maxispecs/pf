import type { Command } from '@pulpfixer/kit/types';
import { runCmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { badgeLabel, h2, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import {
  appEnabled,
  findings,
  parseFidoInfo,
  parseInfo,
  parseOathInfo,
  parsePgpInfo,
  parsePivInfo,
  warnings,
  type AppName,
  type Finding,
  type Snapshot,
} from '../audit.js';
import { ykArgv, ykError, ykRun, type YkTarget } from '../ykman.js';
import { needYkman } from './shared.js';

interface Sub {
  summary: string;
  /** The ykman arguments; `list` does not take --device. */
  args: string[];
  noDevice?: boolean;
}

const SUBS: Record<string, Sub> = {
  status: { summary: 'Model, serial, firmware and enabled applications', args: ['info'] },
  list: { summary: 'Every YubiKey plugged in, with its serial', args: ['list'], noDevice: true },
  oath: { summary: 'OATH: version and whether the accounts have a password', args: ['oath', 'info'] },
  fido: { summary: 'FIDO2: PIN attempts and minimum PIN length', args: ['fido', 'info'] },
  creds: { summary: 'Passkeys stored on the key (asks for the FIDO2 PIN)', args: ['fido', 'credentials', 'list'] },
  piv: { summary: 'PIV (smart card): PIN attempts and management key', args: ['piv', 'info'] },
  pgp: { summary: 'OpenPGP: PIN attempts, KDF and signature policy', args: ['openpgp', 'info'] },
};

const ALIASES: Record<string, string> = { info: 'status', passkeys: 'creds', openpgp: 'pgp', check: 'audit' };

const MENU: { name: string; summary: string }[] = [
  { name: 'audit', summary: 'Check the key for weak or missing security settings' },
  ...Object.entries(SUBS).map(([name, s]) => ({ name, summary: s.summary })),
];

const ICON: Record<Finding['level'], (c: ReturnType<typeof out>) => string> = {
  ok: (c) => c.green('✔'),
  warn: (c) => c.yellow('!'),
  info: (c) => c.dim('i'),
};

/** Read what the audit needs from the key. Null (after printing why) when the key cannot be read. */
function readKey(t: YkTarget): Snapshot | null {
  const c = err();
  const base = ykRun(ykArgv(['info'], t));
  if (!base.ok) {
    process.stderr.write(`${badgeLabel('error', c)} ${ykError(base)}\n${c.dim('Is a YubiKey plugged in? With several, pick one with --device <serial> (pf yk list).')}\n`);
    return null;
  }
  const snap: Snapshot = { info: parseInfo(base.stdout), unreadable: [] };
  const read = <T>(app: AppName, args: string[], parse: (text: string) => T): T | undefined => {
    if (!appEnabled(snap.info, app)) return undefined;
    const r = ykRun(ykArgv(args, t));
    if (r.ok) return parse(r.stdout);
    snap.unreadable!.push({ app, reason: ykError(r) });
    return undefined;
  };
  const oath = read('OATH', ['oath', 'info'], parseOathInfo);
  const fido = read('FIDO2', ['fido', 'info'], parseFidoInfo);
  const piv = read('PIV', ['piv', 'info'], parsePivInfo);
  const pgp = read('OpenPGP', ['openpgp', 'info'], parsePgpInfo);
  if (oath) snap.oath = oath;
  if (fido) snap.fido = fido;
  if (piv) snap.piv = piv;
  if (pgp) snap.pgp = pgp;
  return snap;
}

function printAudit(snap: Snapshot, list: Finding[]): void {
  const c = out();
  const i = snap.info;
  const who = [i.type ?? 'YubiKey', i.firmware ? `firmware ${i.firmware}` : '', i.serial ? `serial ${i.serial}` : ''].filter(Boolean).join('  ');
  process.stdout.write(`${h2(who, c)}\n\n`);
  const width = Math.max(...list.map((f) => f.area.length), 0);
  for (const f of list) {
    process.stdout.write(`  ${ICON[f.level](c)} ${c.dim(f.area.padEnd(width))}  ${f.msg}\n`);
    if (f.fix) process.stdout.write(`    ${' '.repeat(width + 2)}${/^https?:/.test(f.fix) ? c.dim(f.fix) : termLine(f.fix, c)}\n`);
  }
  const n = warnings(list);
  process.stdout.write(`\n${n ? c.yellow(`${n} thing${n === 1 ? '' : 's'} to fix`) : c.green('no warnings')}\n`);
}

async function audit(t: YkTarget, dryRun: boolean, strict: boolean): Promise<number> {
  if (dryRun) {
    for (const args of [['info'], ['oath', 'info'], ['fido', 'info'], ['piv', 'info'], ['openpgp', 'info']]) await runCmd({ argv: ykArgv(args, t) }, { dryRun });
    return 0;
  }
  if (!needYkman()) return 127;
  process.stderr.write(`${err().dim('reading the YubiKey (read-only)…')}\n`);
  const snap = readKey(t);
  if (!snap) return 1;
  const list = findings(snap);
  printAudit(snap, list);
  return strict && warnings(list) > 0 ? 1 : 0;
}

export const ykCommand: Command = {
  name: 'yk',
  summary: 'YubiKey status and security check (ykman)',
  group: 'Security',
  usage: 'pf yk [audit|status|list|oath|fido|creds|piv|pgp] [--device <serial>] [--strict] [--dry-run]',
  async run(_ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const strict = takeFlag(rest, '--strict');
    const device = takeOption(rest, '--device') ?? takeOption(rest, '-d');
    const t: YkTarget = device ? { device } : {};
    const c = err();

    if (rest.length > 1) {
      process.stderr.write(`${badgeLabel('error', c)} one subcommand at a time: ${termLine('pf yk <audit|status|list|...>', c)}\n`);
      return 2;
    }
    let name = rest[0] ? (ALIASES[rest[0]] ?? rest[0]) : undefined;
    // In a terminal a bare `pf yk` offers the subcommands; piped, it prints the status.
    if (!name && interactive()) {
      const chosen = await pick('YubiKey', MENU.map((m) => ({ value: m.name, label: m.name, hint: m.summary })), { search: false });
      if (!chosen) return 0;
      name = chosen;
    }
    name ??= 'status';

    if (name === 'audit') return audit(t, dryRun, strict);
    const sub = SUBS[name];
    if (!sub) {
      process.stderr.write(`${badgeLabel('error', c)} unknown subcommand "${name}". Try: ${[...MENU.map((m) => m.name)].join(', ')}\n`);
      return 2;
    }
    if (!dryRun && !needYkman()) return 127;
    return runCmd({ argv: ykArgv(sub.args, sub.noDevice ? {} : t) }, { dryRun, quiet: !dryRun });
  },
};
