import { err } from './palette.js';
import { displayVersion } from '../version.js';
import { compareVersions } from '../util.js';

export interface BannerInfo {
  version: string;
  /** Repo name, when inside a repo. */
  repo?: string;
  /** Detected stack labels. */
  stacks?: string[];
  /** Newer version known from the cached update check. */
  latest?: string;
}

/** The one-line banner every pf invocation prints. Goes to stderr so stdout stays pipeable. */
export function renderBanner(info: BannerInfo, c = err()): string {
  const parts = [`${c.boldBrand('pf')} ${c.bold('v' + displayVersion(info.version))}`];
  if (info.repo) {
    const stacks = info.stacks?.length ? `  ${c.dim(info.stacks.join(', '))}` : '';
    parts.push(`${c.cyan(info.repo)}${stacks}`);
  }
  let line = parts.join(c.dim('  ·  '));
  if (info.latest && compareVersions(info.latest, info.version) > 0) {
    line += `  ${c.yellow('↑ v' + displayVersion(info.latest) + ' available, run pf update')}`;
  }
  return line;
}

export function printBanner(info: BannerInfo): void {
  process.stderr.write(renderBanner(info) + '\n');
}
