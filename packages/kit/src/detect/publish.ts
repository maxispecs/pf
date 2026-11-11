import path from 'node:path';
import type { Context } from '../context.js';
import { shellCmd } from '../exec.js';
import { readJson } from '../util.js';
import { repoDeployScript, type StagingPlan } from './deploy.js';
import { nodeManager, nodeRun } from './stacks.js';

/** Scripts that publish a repo's packages to the cellars registry (cellars is staging only for now). */
export const PUBLISH_STAGING_SCRIPTS = ['publish:staging', 'publish:cellars', 'publish-staging', 'staging:publish'];

/**
 * Find what `pf publish staging` (`pf ps`) would run: a `publish:staging` / `publish:cellars` script the
 * repo defines (pulpfixer.json, package.json, composer, local CLI). Nothing is guessed: no script, no publish.
 */
export function detectPublishStaging(ctx: Context): StagingPlan {
  const root = ctx.repo?.root ?? ctx.workdir;
  const override = ctx.config.commands['publish:staging'] ?? ctx.config.commands['publish:cellars'];
  if (override) {
    return { steps: [{ cmd: shellCmd(override.run, path.resolve(root, override.cwd ?? '.')), source: 'pulpfixer.json' }], skipped: [] };
  }
  const pkg = readJson<{ scripts?: Record<string, unknown> }>(root, 'package.json');
  const name = PUBLISH_STAGING_SCRIPTS.find((s) => typeof pkg?.scripts?.[s] === 'string');
  if (name) {
    return { steps: [{ cmd: { argv: nodeRun(nodeManager(root), name), cwd: root }, source: `package.json script ${name}` }], skipped: [] };
  }
  const scripted = repoDeployScript(root, PUBLISH_STAGING_SCRIPTS);
  return { steps: scripted ? [scripted] : [], skipped: [] };
}
