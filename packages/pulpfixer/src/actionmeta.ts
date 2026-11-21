/**
 * Defaults for the repo's actions (what `pf actions` lists and an editor shows as buttons): a codicon and
 * whether the action is featured. A repo overrides both in `pulpfixer.json` (`actions`, or `icon` / `featured`
 * on a custom command). Pure data.
 */
export interface ActionMeta {
  icon: string;
  featured: boolean;
}

const DEFAULTS: Record<string, ActionMeta> = {
  dev: { icon: 'play', featured: false },
  build: { icon: 'package', featured: false },
  test: { icon: 'beaker', featured: false },
  lint: { icon: 'checklist', featured: false },
  install: { icon: 'desktop-download', featured: false },
  doc: { icon: 'book', featured: true },
  deploy: { icon: 'rocket', featured: true },
  'deploy:staging': { icon: 'rocket', featured: true },
  'deploy:production': { icon: 'cloud', featured: true },
  'publish:staging': { icon: 'cloud-upload', featured: true },
  tools: { icon: 'tools', featured: false },
  'git:push': { icon: 'repo-push', featured: true },
  'repo:commit': { icon: 'git-commit', featured: false },
  // The pulpfixer checkout's dev cycle (`pf c`); that repo features it in its own pulpfixer.json.
  cycle: { icon: 'sync', featured: false },
};

/** Fallback for an id with no entry: `install:<target>` shares the install look, anything else is a plain command. */
export function defaultMeta(id: string): ActionMeta {
  return DEFAULTS[id] ?? (id.startsWith('install:') ? DEFAULTS.install! : { icon: 'terminal', featured: false });
}
