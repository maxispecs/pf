import path from 'node:path';
import type { Context } from '../context.js';
import { shellCmd, type Cmd } from '../exec.js';
import { exists, listDir, readJson, readText } from '../util.js';
import { nodeManager, nodeRun, type Candidate } from './stacks.js';

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export const DOC_FRAMEWORKS = [
  'nextra', '@docusaurus/core', 'vitepress', '@astrojs/starlight', 'fumadocs-core', 'fumadocs-ui', 'vocs',
];
const DOC_DIR_NAMES = new Set(['docs', 'doc', 'documentation', 'website']);
const ROOT_SCRIPTS = ['docs:dev', 'docs:start', 'doc:dev', 'docs'];

function usesDocFramework(pkg: Pkg): string | undefined {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return DOC_FRAMEWORKS.find((f) => f in deps);
}

function devScript(pkg: Pkg): string | undefined {
  return ['dev', 'start'].find((s) => typeof pkg.scripts?.[s] === 'string');
}

/** Candidate commands that start the local docs site, best first. */
export function detectDocs(ctx: Context): Candidate[] {
  const root = ctx.workdir;
  const out: Candidate[] = [];
  const cmd = (...argv: string[]): Cmd => ({ argv, cwd: root });

  const override = ctx.config.commands.doc ?? ctx.config.commands.docs;
  if (override && ctx.repo) out.push({ cmd: shellCmd(override.run, path.resolve(ctx.repo.root, override.cwd ?? '.')), source: 'pulpfixer.json' });

  const rootPkg = readJson<Pkg>(root, 'package.json');
  const pm = rootPkg ? nodeManager(root) : 'npm';

  // 1. A root script
  if (rootPkg) {
    for (const s of ROOT_SCRIPTS) {
      if (typeof rootPkg.scripts?.[s] === 'string') out.push({ cmd: cmd(...nodeRun(pm, s)), source: `package.json script ${s}` });
    }
  }

  // 2. A docs package inside the repo
  const dirs = ['docs', 'documentation', 'website'];
  for (const group of ['apps', 'packages']) for (const d of listDir(path.join(root, group))) dirs.push(path.join(group, d));
  for (const rel of dirs) {
    const pkg = readJson<Pkg>(root, rel, 'package.json');
    if (!pkg) continue;
    const named = DOC_DIR_NAMES.has(path.basename(rel));
    const fw = usesDocFramework(pkg);
    const script = devScript(pkg);
    if (script && (named || fw)) {
      out.push({
        cmd: { argv: nodeRun(pm, script), cwd: path.join(root, rel) },
        source: `${rel}${fw ? ` (${fw})` : ''}`,
      });
    }
  }

  // 3. The root package itself is a docs site
  if (rootPkg) {
    const fw = usesDocFramework(rootPkg);
    const script = devScript(rootPkg);
    if (fw && script) out.push({ cmd: cmd(...nodeRun(pm, script)), source: `package.json (${fw})` });
  }

  // 4. Static generators
  for (const base of ['.', 'docs']) {
    if (exists(root, base, '.vitepress')) {
      out.push({ cmd: cmd('npx', 'vitepress', 'dev', base), source: `${base === '.' ? '' : base + '/'}.vitepress` });
    }
  }
  if (exists(root, 'mkdocs.yml') || exists(root, 'mkdocs.yaml')) out.push({ cmd: cmd('mkdocs', 'serve'), source: 'mkdocs.yml' });
  for (const base of ['docs', 'doc', 'source']) {
    if (exists(root, base, 'conf.py')) {
      out.push({ cmd: cmd('sphinx-autobuild', base, path.join(base, '_build', 'html')), source: `${base}/conf.py (Sphinx)` });
    }
  }
  if (exists(root, 'book.toml')) out.push({ cmd: cmd('mdbook', 'serve'), source: 'book.toml (mdBook)' });
  const hugo = ['hugo.toml', 'hugo.yaml', 'hugo.json'].some((f) => exists(root, f)) ||
    (exists(root, 'config.toml') && exists(root, 'content') && /baseURL|baseurl/.test(readText(root, 'config.toml') ?? ''));
  if (hugo) out.push({ cmd: cmd('hugo', 'server'), source: 'Hugo config' });

  return out;
}
