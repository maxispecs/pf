import type { Command, Group } from '@pulpfixer/kit/types';

/** Short names for a full pf command line. Add new ones to SHORTCUTS. */
export interface Shortcut {
  /** Every short name for the target; each one runs it. */
  names: string[];
  /** The full command it stands for, e.g. ['deploy', 'staging']. */
  target: string[];
  summary: string;
  group: Group;
}

export const SHORTCUTS: Shortcut[] = [
  { names: ['a'], target: ['agent'], summary: 'Open the coding agent (pf agent)', group: 'Agent' },
  { names: ['t'], target: ['troubleshoot'], summary: 'Troubleshoot with the agent and AWS (pf troubleshoot)', group: 'Agent' },
  { names: ['docs'], target: ['doc'], summary: 'Run the docs site locally (pf doc)', group: 'Docs & deploy' },
  { names: ['d'], target: ['deploy'], summary: 'Deploy: staging if configured, else production (pf deploy)', group: 'Docs & deploy' },
  { names: ['ds'], target: ['deploy', 'staging'], summary: 'Deploy to staging (pf deploy staging)', group: 'Docs & deploy' },
  { names: ['dp'], target: ['deploy', 'production'], summary: 'Deploy to production (pf deploy production)', group: 'Docs & deploy' },
  { names: ['ps'], target: ['publish', 'staging'], summary: 'Publish to the staging registry, cellars (pf publish staging)', group: 'Docs & deploy' },
  { names: ['r'], target: ['dev'], summary: 'Run the repo (pf dev)', group: 'Tools' },
  { names: ['rp'], target: ['repo'], summary: 'Hook pf tools into this repo or update them (pf repo)', group: 'Tools' },
  { names: ['u'], target: ['update'], summary: 'Update pf, its plugins and skills (pf update)', group: 'Tools' },
  { names: ['v'], target: ['ver'], summary: 'List versions and bump them (pf ver)', group: 'Tools' },
  { names: ['up'], target: ['s3'], summary: 'Upload to the exchange bucket (pf s3)', group: 'AWS' },
];

/** The commands for every name of a shortcut. */
export function shortcutCommands(s: Shortcut, resolve: (name: string) => Command | undefined): Command[] {
  return s.names.map((n) => shortcutCommand(s, n, resolve));
}

/** Build the command `pf <name>` that runs `pf <target...> <args...>`. `resolve` looks up the target command. */
export function shortcutCommand(s: Shortcut, name: string, resolve: (name: string) => Command | undefined): Command {
  const full = `pf ${s.target.join(' ')}`;
  return {
    name,
    summary: s.summary,
    group: s.group,
    usage: `pf ${name} [args]  (same as ${full} [args])`,
    async run(ctx, args) {
      const [name, ...fixed] = s.target;
      const cmd = resolve(name!);
      if (!cmd) {
        process.stderr.write(`pf ${name}: target command "${name}" does not exist\n`);
        return 1;
      }
      return cmd.run(ctx, [...fixed, ...args]);
    },
  };
}
