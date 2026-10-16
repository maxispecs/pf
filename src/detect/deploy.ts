import path from 'node:path';
import type { Context } from '../context.js';
import { shellCmd, type Cmd } from '../exec.js';
import { exists, listDir, readJson, readText } from '../util.js';
import { nodeManager, nodeRun, type Candidate } from './stacks.js';

export interface StagingPlan {
  /** Run in order. */
  steps: Candidate[];
  /** Platforms that were present but have no staging setup, with the reason. */
  skipped: string[];
}

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export const STAGING_SCRIPTS = ['deploy:staging', 'deploy-staging', 'staging:deploy', 'deploy:stage', 'stage:deploy'];

/** npm package that provides each CLI, when it has one. */
const CLI_PACKAGES: Record<string, string> = {
  firebase: 'firebase-tools',
  wrangler: 'wrangler',
  serverless: 'serverless',
  sst: 'sst',
  netlify: 'netlify-cli',
  vercel: 'vercel',
};

/** Run a platform CLI: the local install, else pnpm dlx / npx in Node repos, else the bare binary. */
export function toolCmd(dir: string, root: string, bin: string, args: string[]): Cmd {
  for (const base of [dir, root]) {
    const local = path.join(base, 'node_modules', '.bin', bin);
    if (exists(local)) return { argv: [local, ...args], cwd: dir };
  }
  const pkg = CLI_PACKAGES[bin];
  if (pkg && exists(root, 'package.json')) {
    const pm = nodeManager(root);
    if (pm === 'pnpm') return { argv: ['pnpm', 'dlx', pkg, ...args], cwd: dir };
    if (pm === 'bun') return { argv: ['bunx', pkg, ...args], cwd: dir };
    return { argv: ['npx', '--yes', pkg, ...args], cwd: dir };
  }
  return { argv: [bin, ...args], cwd: dir };
}

function workspaceDirs(root: string): string[] {
  const dirs = [root];
  for (const group of ['apps', 'packages', 'services']) {
    for (const d of listDir(path.join(root, group))) {
      const p = path.join(root, group, d);
      if (exists(p, 'package.json') || exists(p, 'firebase.json') || exists(p, 'wrangler.toml') || exists(p, 'vercel.json')) dirs.push(p);
    }
  }
  return dirs;
}

/** Find what `pf deploy staging` would run. Production is never targeted. */
export function detectStaging(ctx: Context): StagingPlan {
  const root = ctx.repo?.root ?? ctx.workdir;
  const rel = (d: string) => path.relative(root, d) || '.';
  const skipped: string[] = [];

  // 0. pf.json
  const override = ctx.config.commands['deploy:staging'];
  if (override) {
    return { steps: [{ cmd: shellCmd(override.run, path.resolve(root, override.cwd ?? '.')), source: 'pf.json' }], skipped };
  }

  const dirs = workspaceDirs(root);

  // 1. A deploy:staging style script in the root or a workspace package
  for (const d of dirs) {
    const pkg = readJson<Pkg>(d, 'package.json');
    if (!pkg) continue;
    const name = STAGING_SCRIPTS.find((s) => typeof pkg.scripts?.[s] === 'string');
    if (name) {
      return { steps: [{ cmd: { argv: nodeRun(nodeManager(root), name), cwd: d }, source: `${rel(d)}/package.json script ${name}` }], skipped };
    }
  }

  // 2. A staging workflow that can be dispatched
  const wfDir = path.join(root, '.github', 'workflows');
  for (const f of listDir(wfDir).sort()) {
    if (!/stag/i.test(f) || !/\.ya?ml$/.test(f)) continue;
    if (/workflow_dispatch/.test(readText(wfDir, f) ?? '')) {
      return { steps: [{ cmd: { argv: ['gh', 'workflow', 'run', f], cwd: root }, source: `.github/workflows/${f}` }], skipped };
    }
  }

  // 3. Platform configs: every one found runs, in order
  const steps: Candidate[] = [];
  for (const d of dirs) {
    const where = rel(d) === '.' ? '' : ` in ${rel(d)}`;
    const pkg = readJson<Pkg>(d, 'package.json');
    const pm = nodeManager(root);

    if (exists(d, 'firebase.json')) {
      const rc = readJson<{ projects?: Record<string, string> }>(d, '.firebaserc');
      if (rc?.projects && 'staging' in rc.projects) {
        if (typeof pkg?.scripts?.build === 'string') steps.push({ cmd: { argv: nodeRun(pm, 'build'), cwd: d }, source: `firebase${where}` });
        steps.push({ cmd: toolCmd(d, root, 'firebase', ['deploy', '--project', 'staging']), source: `firebase${where}` });
      } else {
        skipped.push(`firebase${where}: no "staging" alias in .firebaserc`);
      }
    }

    const wrangler = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].find((f) => exists(d, f));
    if (wrangler) {
      const text = readText(d, wrangler) ?? '';
      const hasEnv = wrangler.endsWith('.toml') ? /^\s*\[env\.staging[\].]/m.test(text) : /"env"\s*:\s*\{[\s\S]*"staging"/.test(text);
      if (hasEnv) steps.push({ cmd: toolCmd(d, root, 'wrangler', ['deploy', '--env', 'staging']), source: `${wrangler}${where}` });
      else skipped.push(`wrangler${where}: no staging environment in ${wrangler}`);
    }

    if (exists(d, 'fly.staging.toml')) steps.push({ cmd: toolCmd(d, root, 'fly', ['deploy', '--config', 'fly.staging.toml']), source: `fly.staging.toml${where}` });

    if (listDir(d).some((f) => /^serverless\.(ya?ml|ts|js|json)$/.test(f))) {
      steps.push({ cmd: toolCmd(d, root, 'serverless', ['deploy', '--stage', 'staging']), source: `serverless${where}` });
    }
    if (exists(d, 'sst.config.ts')) steps.push({ cmd: toolCmd(d, root, 'sst', ['deploy', '--stage', 'staging']), source: `sst${where}` });

    // Draft deploy only, never --prod
    if (exists(d, 'netlify.toml')) steps.push({ cmd: toolCmd(d, root, 'netlify', ['deploy', '--build']), source: `netlify${where}` });

    const vercel = exists(d, 'vercel.json') || exists(d, '.vercel', 'project.json') ||
      Boolean(pkg && 'vercel' in { ...pkg.dependencies, ...pkg.devDependencies });
    if (vercel) steps.push({ cmd: toolCmd(d, root, 'vercel', ['deploy']), source: `vercel${where} (preview)` });
  }
  return { steps, skipped };
}
