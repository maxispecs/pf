import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_LINE, PACKAGE_NAME, REGISTRY_URL, pfHome } from '@pulpfixer/kit/constants';
import { capture } from '@pulpfixer/kit/exec';
import { userConfigPath, writeHomeFile } from '@pulpfixer/kit/config';
import { bashCompletion, fishCompletion, rcBlock, RC_START, zshCompletion, type CompletionEntry } from '../install/completions.js';
import { globalBinOnPath, legacyGlobal, npmrcHasCellarsAuth, pfOnPath, userNpmrc } from '../install/env.js';
import { out } from '@pulpfixer/kit/ui/palette';
import { confirm, reporter } from '@pulpfixer/kit/ui/prompt';
import { takeFlag } from '@pulpfixer/kit/util';
import type { Command } from '@pulpfixer/kit/types';

function shellName(): 'zsh' | 'bash' | 'fish' | null {
  const s = path.basename(process.env.SHELL ?? '');
  return s === 'zsh' || s === 'bash' || s === 'fish' ? s : null;
}

function rcFile(shell: 'zsh' | 'bash'): string {
  const home = os.homedir();
  if (shell === 'zsh') return path.join(process.env.ZDOTDIR ?? home, '.zshrc');
  const bashrc = path.join(home, '.bashrc');
  return fs.existsSync(bashrc) || process.platform !== 'darwin' ? bashrc : path.join(home, '.bash_profile');
}

/** Command names and summaries for shell completion. */
async function completionEntries(): Promise<CompletionEntry[]> {
  const { allCommands } = await import('./index.js');
  return allCommands().map((c) => ({ name: c.name, summary: c.summary }));
}

export const setupCommand: Command = {
  name: 'setup',
  summary: 'Set this machine up for pf (registry, completions, legacy cleanup)',
  group: 'Tools',
  usage: 'pf setup [--dry-run] [--yes] [--no-completions]',
  async run(_ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const yes = takeFlag(rest, '--yes', '-y');
    const noCompletions = takeFlag(rest, '--no-completions');
    const c = out();
    const r = reporter(c);
    const ask = (q: string, fallback: boolean) => (yes ? Promise.resolve(true) : confirm(q, fallback, { flag: '--yes' }));
    let problems = 0;

    process.stdout.write(`${c.bold('pf setup')}${dryRun ? c.dim('  (dry run: nothing is changed)') : ''}\n`);

    // 1. Node
    r.step('Node');
    const major = parseInt(process.versions.node.split('.')[0]!, 10);
    if (major >= 18) r.ok(`Node ${process.versions.node}`);
    else {
      r.fail(`Node ${process.versions.node} is too old: pf needs Node >= 18`);
      return 1;
    }
    const bin = globalBinOnPath();
    if (bin.ok) r.ok(`npm global bin on PATH (${bin.bin})`);
    else if (bin.bin) {
      r.warn(`npm global bin ${bin.bin} is not on PATH`);
      r.info(`Add it: export PATH="${bin.bin}:$PATH"`);
    } else r.warn('npm not found: global installs and updates need npm');

    // 2. Registry
    r.step('Cellars registry');
    if (npmrcHasCellarsAuth()) r.ok(`auth line for ${REGISTRY_URL} found in ${userNpmrc()}`);
    else if (process.env.NPM_TOKEN) {
      if (await ask(`Add the cellars auth line (using $NPM_TOKEN) to ${userNpmrc()}?`, true)) {
        if (dryRun) r.info(`would append: ${AUTH_LINE}`);
        else {
          try {
            const file = userNpmrc();
            const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${AUTH_LINE}\n`);
            r.ok(`added the auth line to ${file} (the token itself is never written)`);
          } catch (e) {
            r.fail(`could not write ${userNpmrc()}: ${(e as Error).message}`);
            problems++;
          }
        }
      } else r.warn('skipped: installs and updates from cellars need the auth line');
    } else {
      r.warn('no cellars auth: export NPM_TOKEN (token from #frontend), then rerun pf setup');
      problems++;
    }
    r.info(`pf installs and updates with --registry ${REGISTRY_URL}, so your default npm registry is left alone`);

    // 3. Legacy pulpfixer
    r.step('Legacy pulpfixer');
    const legacy = legacyGlobal();
    const legacyBins = pfOnPath().filter((p) => p.legacy);
    if (legacy) {
      r.warn(`legacy pulpfixer ${legacy.version} is installed globally (${legacy.dir})`);
      if (dryRun) r.info(`would offer to run: npm rm -g ${PACKAGE_NAME}`);
      else if (await ask('Remove it so pf v2 takes over the `pf` command?', false)) {
        const res = capture(['npm', 'rm', '-g', PACKAGE_NAME], { timeout: 120_000 });
        if (res.ok) {
          r.ok(`removed legacy pulpfixer ${legacy.version}`);
          r.info(`Install v2: npm i -g ${PACKAGE_NAME} --registry ${REGISTRY_URL}  (or scripts/install.sh from a checkout)`);
        } else {
          r.fail('npm rm -g failed. Try it yourself, with sudo if the prefix needs it');
          problems++;
        }
      } else {
        r.warn('left in place: the legacy `pf` still wins on PATH');
        problems++;
      }
      r.info('Its data in ~/.pulpfixer is not touched');
    } else if (legacyBins.length) {
      r.warn(`legacy pf on PATH: ${legacyBins.map((p) => `${p.path} (${p.version})`).join(', ')}`);
      problems++;
    } else r.ok('no legacy install found');

    // 4. Completions and config
    r.step('Shell and config');
    const shell = shellName();
    if (noCompletions) r.info('completions skipped (--no-completions)');
    else if (!shell) r.warn(`unknown shell (${process.env.SHELL ?? 'SHELL unset'}): completions skipped`);
    else {
      const entries = await completionEntries();
      if (dryRun) r.info(`would write ${shell} completions under ${pfHome()}/completions`);
      else {
        let ok = writeHomeFile('completions/pf.zsh', zshCompletion(entries));
        ok = writeHomeFile('completions/pf.bash', bashCompletion(entries)) && ok;
        if (shell === 'fish') {
          try {
            const dir = path.join(os.homedir(), '.config', 'fish', 'completions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'pf.fish'), fishCompletion(entries));
          } catch {
            ok = false;
          }
        }
        if (!ok) r.warn(`could not write completions (is ${pfHome()} writable?)`);
        else if (shell === 'fish') r.ok('fish completions installed (~/.config/fish/completions/pf.fish)');
        else {
          const rc = rcFile(shell);
          const text = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
          if (text.includes(RC_START)) r.ok(`${shell} completions already wired in ${rc}`);
          else if (await ask(`Add the pf completion block to ${rc}?`, true)) {
            try {
              fs.appendFileSync(rc, `${text && !text.endsWith('\n') ? '\n' : ''}\n${rcBlock(shell, pfHome())}`);
              r.ok(`wired ${shell} completions in ${rc} (open a new shell)`);
            } catch (e) {
              r.warn(`could not write ${rc}: ${(e as Error).message}`);
            }
          } else r.info(`to wire them yourself: source ${pfHome()}/completions/pf.${shell}`);
        }
      }
    }
    if (fs.existsSync(userConfigPath())) r.ok(`config ${userConfigPath()}`);
    else if (dryRun) r.info(`would create ${userConfigPath()}`);
    else if (writeHomeFile('config.json', JSON.stringify({ skillDirs: [] }, null, 2) + '\n')) r.ok(`created ${userConfigPath()}`);
    else r.warn(`could not create ${userConfigPath()} (read-only home?): pf still works without it`);

    process.stdout.write(`\n${problems ? c.yellow(`Done with ${problems} item(s) needing attention.`) : c.green('All set.')} Run ${c.bold('pf doctor')} to verify.\n`);
    return problems ? 1 : 0;
  },
};
