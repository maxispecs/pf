import type { Command } from '@pulpfixer/kit/types';
import { runCmd } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { accountsArgv, codeArgv, copyText, isCode, parseAccounts, ykError, ykRun, type YkTarget } from '../ykman.js';
import { needYkman } from './shared.js';

/** Print the code on stdout (so `pf otp x | ...` works) and optionally copy it. */
function deliver(code: string, copy: boolean): void {
  const c = err();
  process.stdout.write(code + '\n');
  if (!copy) return;
  const tool = copyText(code);
  if (tool) process.stderr.write(`${c.green('✓')} copied to the clipboard ${c.dim(`(${tool})`)}\n`);
  else process.stderr.write(`${badgeLabel('warning', c)} no clipboard tool found (pbcopy, wl-copy, xclip, xsel or clip), the code is printed above\n`);
}

/** One code from ykman, or null after telling the user what went wrong. ykman shows its own prompts (password, touch). */
function fetchCode(t: YkTarget, query: string, hidden: boolean): string | null {
  const r = ykRun(codeArgv(t, { query, single: true, hidden }), { interactive: true });
  if (!r.ok) {
    // ykman already printed its reason on the terminal (no match, several matches, wrong password).
    if (r.status === 127) process.stderr.write(`${badgeLabel('error', err())} ${ykError(r)}\n`);
    return null;
  }
  const code = r.stdout.trim();
  if (!isCode(code)) {
    process.stderr.write(`${badgeLabel('error', err())} unexpected output from ykman oath accounts code\n`);
    return null;
  }
  return code;
}

export const otpCommand: Command = {
  name: 'otp',
  summary: 'Six-digit codes from your YubiKey (ykman oath)',
  group: 'Security',
  usage: 'pf otp [account] [--copy] [--all] [--list] [--hidden] [--device <serial>] [--dry-run]',
  async run(_ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const copy = takeFlag(rest, '--copy', '-c');
    const all = takeFlag(rest, '--all', '-a');
    const list = takeFlag(rest, '--list', '-l');
    const hidden = takeFlag(rest, '--hidden', '-H');
    const device = takeOption(rest, '--device') ?? takeOption(rest, '-d');
    const t: YkTarget = device ? { device } : {};
    const query = rest.join(' ').trim();
    const c = err();

    if (all && query) {
      process.stderr.write(`${badgeLabel('error', c)} --all shows every account, so it takes no account name\n`);
      return 2;
    }
    if (!dryRun && !needYkman()) return 127;

    // Names without codes (a list), or every code in ykman's own table (--all).
    if (list || all) return runCmd({ argv: all ? codeArgv(t, { hidden }) : accountsArgv(t, { hidden }) }, { dryRun, quiet: !dryRun });

    if (query) {
      if (dryRun) return runCmd({ argv: codeArgv(t, { query, single: true, hidden }) }, { dryRun });
      const code = fetchCode(t, query, hidden);
      if (code === null) return 1;
      deliver(code, copy);
      return 0;
    }

    // No account named: choose from the list in a terminal, otherwise print the names.
    if (dryRun) {
      await runCmd({ argv: accountsArgv(t, { hidden }) }, { dryRun });
      return runCmd({ argv: codeArgv(t, { query: '<account>', single: true, hidden }) }, { dryRun });
    }
    if (!interactive()) return runCmd({ argv: accountsArgv(t, { hidden }) }, { quiet: true });

    const names = ykRun(accountsArgv(t, { hidden }), { interactive: true });
    if (!names.ok) {
      if (names.status === 127) process.stderr.write(`${badgeLabel('error', c)} ${ykError(names)}\n`);
      return 1;
    }
    const accounts = parseAccounts(names.stdout);
    if (accounts.length === 0) {
      process.stderr.write(`${c.dim('no OATH accounts on this YubiKey. Add one with')} ${termLine('ykman oath accounts add', c)}\n`);
      return 0;
    }
    const chosen = await pick('Account', accounts.map((a) => ({ value: a, label: a })), { search: accounts.length > 8 });
    if (!chosen) return 0;
    // Ask for the code only now: one picked a while ago would be stale (it lasts 30 seconds).
    const code = fetchCode(t, chosen, hidden);
    if (code === null) return 1;
    deliver(code, copy);
    return 0;
  },
};
