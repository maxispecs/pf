import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { badgeLabel, table, termLine } from '@pulpfixer/kit/ui/text';
import { takeFlag, takeOption } from '@pulpfixer/kit/util';
import { liveGrants, minutesLeft, revokeGrants, type Grant } from '../grants.js';

function showGrants(): number {
  const grants = liveGrants();
  const c = out();
  if (grants.length === 0) {
    process.stdout.write(`${c.dim('No live AWS grants. The agent asks for one with pf_aws_request_access.')}\n`);
    return 0;
  }
  const rows = grants.map((g) => [
    g.session,
    g.profile,
    g.scopes.join(', '),
    g.regions ? g.regions.join(', ') : 'any',
    `${minutesLeft(g)} min`,
    g.approvedBy === 'dialog' ? 'pf dialog' : 'agent prompt',
    g.reason.length > 60 ? `${g.reason.slice(0, 57)}...` : g.reason,
  ]);
  process.stdout.write(table(['session', 'profile', 'scopes', 'regions', 'left', 'approved in', 'reason'], rows, c) + '\n');
  process.stderr.write(`${err().dim('End one with')} ${termLine('pf aws revoke <session>', err())} ${err().dim('or all with')} ${termLine('pf aws revoke --all', err())}\n`);
  return 0;
}

function revoke(args: string[]): number {
  const c = err();
  const dryRun = takeFlag(args, '--dry-run', '-n');
  const all = takeFlag(args, '--all');
  const profile = takeOption(args, '--profile');
  const session = args[0];
  if (!all && !profile && !session) {
    process.stderr.write(`${badgeLabel('error', c)} say which grant to end: ${termLine('pf aws revoke <session> | --profile <name> | --all', c)}\n`);
    return 2;
  }
  const match = (g: Grant) => all || (profile !== undefined && g.profile === profile) || (session !== undefined && g.session === session);
  const hits = liveGrants().filter(match);
  if (hits.length === 0) {
    process.stderr.write(`${c.dim('no matching live grant')}\n`);
    return 0;
  }
  if (dryRun) {
    for (const g of hits) process.stderr.write(`${c.dim('would revoke')} ${g.session} (${g.profile}: ${g.scopes.join(', ')})\n`);
    return 0;
  }
  const n = revokeGrants(match);
  if (n === null) {
    process.stderr.write(`${badgeLabel('error', c)} could not write the grants file\n`);
    return 1;
  }
  process.stderr.write(`${c.green('✓')} revoked ${n} grant${n === 1 ? '' : 's'}; the agent's next AWS call is refused\n`);
  return 0;
}

export const awsCommand: Command = {
  name: 'aws',
  summary: 'AWS access granted to the agent: list and revoke',
  group: 'AWS',
  usage: 'pf aws [grants] | pf aws revoke <session>|--profile <name>|--all [--dry-run]',
  async run(_ctx, args) {
    const rest = [...args];
    const sub = rest.shift() ?? 'grants';
    if (sub === 'grants' || sub === 'list') return showGrants();
    if (sub === 'revoke') return revoke(rest);
    process.stderr.write(`${badgeLabel('error', err())} unknown subcommand "${sub}". ${termLine(awsCommand.usage, err())}\n`);
    return 2;
  },
};
