import type { Command, Group } from '@pulpfixer/kit/types';

/** A short name for a full pf command line. Add new ones to SHORTCUTS. */
export interface Shortcut {
  name: string;
  /** The full command it stands for, e.g. ['deploy', 'staging']. */
  target: string[];
  summary: string;
  group: Group;
}

export const SHORTCUTS: Shortcut[] = [
  { name: 'ds', target: ['deploy', 'staging'], summary: 'Deploy to staging (pf deploy staging)', group: 'Docs & deploy' },
  { name: 'dp', target: ['deploy', 'production'], summary: 'Deploy to production (pf deploy production)', group: 'Docs & deploy' },
];

/** Build a command that runs `pf <target...> <args...>`. `resolve` looks up the target command. */
export function shortcutCommand(s: Shortcut, resolve: (name: string) => Command | undefined): Command {
  const full = `pf ${s.target.join(' ')}`;
  return {
    name: s.name,
    summary: s.summary,
    group: s.group,
    usage: `pf ${s.name} [args]  (same as ${full} [args])`,
    async run(ctx, args) {
      const [name, ...fixed] = s.target;
      const cmd = resolve(name!);
      if (!cmd) {
        process.stderr.write(`pf ${s.name}: target command "${name}" does not exist\n`);
        return 1;
      }
      return cmd.run(ctx, [...fixed, ...args]);
    },
  };
}
