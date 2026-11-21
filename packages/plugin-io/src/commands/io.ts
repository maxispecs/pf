import { ioAdapterOrigin, ioAdapters } from '@pulpfixer/kit/io';
import type { Command } from '@pulpfixer/kit/types';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { badge, table, termLine } from '@pulpfixer/kit/ui/text';
import { takeFlag } from '@pulpfixer/kit/util';

const say = (s: string): void => void process.stderr.write(s + '\n');

function adapters(args: string[]): number {
  const json = takeFlag(args, '--json');
  if (args.length) {
    say(badge.error(`unexpected ${args.join(' ')}`, err()));
    return 2;
  }
  const list = ioAdapters().map((a) => ({
    id: a.id,
    label: a.label,
    read: Boolean(a.source),
    write: Boolean(a.sink),
    origin: ioAdapterOrigin(a.id) ?? 'unknown',
  }));
  if (json) {
    process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    return 0;
  }
  const c = out();
  if (list.length === 0) {
    process.stdout.write(`${c.dim('No IO adapters are registered.')}\n`);
    return 0;
  }
  process.stdout.write(
    table(
      ['adapter', 'what', 'read', 'write', 'from'],
      list.map((a) => [a.id, a.label, a.read ? 'yes' : '-', a.write ? 'yes' : '-', a.origin]),
      c,
    ) + '\n',
  );
  say(`${err().dim('More adapters are plugins:')} ${termLine('pf plugin install io-<name>', err())}${err().dim('. Pipes use them: pf plugin install pipe-<name>')}`);
  return 0;
}

export const ioCommand: Command = {
  name: 'io',
  summary: 'IO adapters that pipes read from and write to',
  group: 'Tools',
  usage: 'pf io [adapters] [--json]',
  async run(_ctx, args) {
    const rest = [...args];
    const sub = rest[0];
    if (!sub || sub === 'adapters' || sub === 'list') {
      if (sub) rest.shift();
      return adapters(rest);
    }
    say(`${badge.error(`unknown subcommand "${sub}"`, err())}\n  ${err().dim('usage')} ${termLine(ioCommand.usage, err())}`);
    return 2;
  },
};
