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
  { names: ['a'], target: ['agent'], summary: 'Open the coding agent', group: 'Agent' },
  { names: ['t'], target: ['troubleshoot'], summary: 'Troubleshoot with the agent and AWS', group: 'Agent' },
  { names: ['docs'], target: ['doc'], summary: 'Run the docs site locally', group: 'Docs & deploy' },
  { names: ['d'], target: ['deploy'], summary: 'Deploy: staging if configured, else production', group: 'Docs & deploy' },
  { names: ['ds'], target: ['deploy', 'staging'], summary: 'Deploy to staging', group: 'Docs & deploy' },
  { names: ['dp'], target: ['deploy', 'production'], summary: 'Deploy to production', group: 'Docs & deploy' },
  { names: ['ps'], target: ['publish', 'staging'], summary: 'Publish to the staging registry, cellars', group: 'Docs & deploy' },
  { names: ['r'], target: ['dev'], summary: 'Run the repo', group: 'Develop' },
  { names: ['i'], target: ['install'], summary: 'Install: the repo\'s install target, else dependencies', group: 'Develop' },
  { names: ['il', 'install-local'], target: ['install', 'local'], summary: 'Install locally (the repo\'s install:local)', group: 'Develop' },
  { names: ['gp'], target: ['git', 'push'], summary: 'Push to the primary remote and the backup remotes set up here', group: 'Develop' },
  { names: ['g'], target: ['repo', 'commit'], summary: 'Commit everything with a message written from the last chat', group: 'Develop' },
  { names: ['rp'], target: ['repo'], summary: 'Hook pf tools into this repo or update them', group: 'Tools' },
  { names: ['u'], target: ['update'], summary: 'Update pf, its plugins and skills', group: 'Tools' },
  { names: ['v'], target: ['ver'], summary: 'List versions and bump them', group: 'Tools' },
  { names: ['vs'], target: ['versions'], summary: 'List versions of pf, plugins, skills and extensions installed here', group: 'Tools' },
  { names: ['s'], target: ['shortcuts'], summary: 'List the shortcuts', group: 'Help' },
  { names: ['up'], target: ['s3'], summary: 'Upload to the exchange bucket', group: 'AWS' },
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
