import { loadRepoConfig, repoConfigName, setRepoConfigSection } from '@pulpfixer/kit/config';
import { findRepoLogo, normalizeLogoPath } from '@pulpfixer/kit/detect/logo';
import { err } from '@pulpfixer/kit/ui/palette';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { exists, interactive } from '@pulpfixer/kit/util';
import { bgToneStatus, installSuite, type BgToneStatus } from '@pulpfixer/plugin-system';

/**
 * The Background Tone part of `pf repo`: the extension (`@pulpfixer/ext-bg-tone`, part of the pulpfixer suite)
 * keeps its settings in the `bgTone` section of `pulpfixer.json`, so a repo that is set up for pf gets its logo
 * there, and Cursor gets the extension when it is missing.
 */

/** What the step touches outside the repo, replaceable in tests. */
export interface ToneDeps {
  status(): BgToneStatus;
  install(): Promise<number>;
  interactive(): boolean;
  confirm(question: string): Promise<boolean>;
}

export const toneDeps: ToneDeps = {
  status: bgToneStatus,
  install: () => installSuite({ yes: true }),
  interactive,
  confirm: (q) => confirm(q, true),
};

const short = (v: string): string => v.replace(/^(\d+\.\d+)\.0$/, '$1');

/**
 * Set `bgTone.logo` from an image in the repo when the config has none. Never overwrites a logo that is set
 * (even one that is missing on disk: that is reported, not replaced).
 */
export function setupToneLogo(root: string, dryRun: boolean, done: string[]): number {
  const c = err();
  const file = repoConfigName(root);
  const set = loadRepoConfig(root).bgTone?.logo;
  if (typeof set === 'string' && set.trim() !== '') {
    const rel = normalizeLogoPath(set);
    if (!rel) {
      process.stderr.write(`${badgeLabel('warning', c)} bgTone.logo in ${file} (${set}) is not an image path inside the repo; left as is\n`);
      done.push(`logo: bgTone.logo "${set}" is not a usable path, left as is`);
    } else if (!exists(root, ...rel.split('/'))) {
      process.stderr.write(`${badgeLabel('warning', c)} bgTone.logo in ${file} points to ${rel}, which does not exist; left as is\n`);
      done.push(`logo: bgTone.logo ${rel} is missing from the repo, left as is`);
    } else done.push(`logo: bgTone.logo is already ${rel}`);
    return 0;
  }
  const found = findRepoLogo(root);
  if (!found) {
    done.push('logo: no logo image found in the repo (put one at assets/logo.svg and run pf rp again)');
    return 0;
  }
  const w = setRepoConfigSection(root, 'bgTone', { logo: found.path }, { dryRun });
  if (!w.ok) {
    process.stderr.write(`${badgeLabel('error', c)} ${w.error}\n`);
    return 1;
  }
  done.push(`logo: ${dryRun ? 'would set' : 'set'} bgTone.logo to ${found.path} in ${file} (${found.reason})`);
  return 0;
}

/** Offer the extension to Cursor when it is not there, or report the version that is. */
export async function setupToneExtension(dryRun: boolean, done: string[], deps: ToneDeps = toneDeps): Promise<number> {
  const c = err();
  const s = deps.status();
  if (!s.cursor) {
    done.push('extension: Cursor not found here, nothing to install');
    return 0;
  }
  if (!s.cli) {
    done.push('extension: the cursor command was not found, so the Background Tone extension cannot be checked or installed');
    return 0;
  }
  if (s.unknown) {
    done.push('extension: could not read the list of Cursor extensions');
    return 0;
  }
  if (s.installed !== null) {
    done.push(`extension: Background Tone${s.installed ? ` v${short(s.installed)}` : ''} is installed in Cursor (pf update keeps it current)`);
    return 0;
  }
  const hint = termLine('pf sys apply suite', c);
  if (dryRun) {
    done.push('extension: Background Tone is not in Cursor, pf rp would offer to install it (pf sys apply suite)');
    return 0;
  }
  if (!deps.interactive()) {
    done.push(`extension: Background Tone is not in Cursor, run ${hint} to install it`);
    return 0;
  }
  if (!(await deps.confirm('Install the Background Tone extension (pulpfixer suite) into Cursor?'))) {
    done.push(`extension: not installed, run ${hint} later`);
    return 0;
  }
  const code = await deps.install();
  if (code !== 0) {
    process.stderr.write(`${badgeLabel('warning', c)} the Background Tone install did not finish; run ${hint} to see why\n`);
    done.push('extension: install failed');
    return 0;
  }
  done.push('extension: Background Tone installed in Cursor (reload the Cursor window to see it)');
  return 0;
}

/** Both parts, for `pf repo`. */
export async function setupTone(root: string, dryRun: boolean, done: string[], deps: ToneDeps = toneDeps): Promise<number> {
  const logo = setupToneLogo(root, dryRun, done);
  if (logo !== 0) return logo;
  return setupToneExtension(dryRun, done, deps);
}
