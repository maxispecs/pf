import type { Context } from '../context.js';

export const GROUPS = ['Develop', 'Build & check', 'Docs & deploy', 'Tools', 'Help'] as const;
export type Group = (typeof GROUPS)[number];

export interface Command {
  name: string;
  summary: string;
  group: Group;
  usage: string;
  /** Hidden from lists and menus (still runnable). */
  hidden?: boolean;
  run(ctx: Context, args: string[]): Promise<number>;
}

/** One selectable line in a menu or the static list. */
export interface Entry {
  name: string;
  summary: string;
  group: string;
  /** What running it does, e.g. the resolved command. */
  detail?: string;
  run: () => Promise<number>;
}
