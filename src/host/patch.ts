import fs from 'node:fs';
import { captureAsync, type Cmd } from '../exec.js';
import { which } from '../util.js';

/** OS package managers pf can patch with. */
export type PackageManager = 'dnf' | 'yum' | 'apt';

export function detectPackageManager(has: (bin: string) => boolean = (b) => Boolean(which(b))): PackageManager | null {
  if (has('dnf')) return 'dnf';
  if (has('yum')) return 'yum';
  if (has('apt-get')) return 'apt';
  return null;
}

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive' };

/** Commands that list pending security updates. apt refreshes its index first. */
export function listSecurityCmds(pm: PackageManager): Cmd[] {
  if (pm === 'dnf') return [{ argv: ['dnf', '-q', '--refresh', 'updateinfo', 'list', '--security', '--available'] }];
  if (pm === 'yum') return [{ argv: ['yum', '-q', 'updateinfo', 'list', 'security', 'available'] }];
  return [{ argv: ['apt-get', 'update', '-q'] }, { argv: ['apt-get', '-s', 'dist-upgrade'] }];
}

export interface SecurityUpdate {
  /** Package name as the manager reports it (dnf/yum: name-version.arch). */
  pkg: string;
  /** Advisory id and severity on dnf/yum (ALAS2023-2025-123 important/Sec.), the suite on apt. */
  advisory: string;
}

/** Parse the output of the last list command. */
export function parseSecurityUpdates(pm: PackageManager, output: string): SecurityUpdate[] {
  const seen = new Set<string>();
  const out: SecurityUpdate[] = [];
  for (const line of output.split('\n')) {
    let u: SecurityUpdate | null = null;
    if (pm === 'apt') {
      const m = /^Inst (\S+) (?:\[[^\]]*\] )?\((\S+) ([^)]*)\)/.exec(line);
      if (m && /-security\b/.test(m[3]!)) u = { pkg: m[1]!, advisory: `${m[2]} ${m[3]!.split(' ')[0]}` };
    } else {
      const m = /^(\S+)\s+(\S+\/Sec\.|\S*[Ss]ecurity\S*)\s+(\S+)$/.exec(line.trim());
      if (m) u = { pkg: m[3]!, advisory: `${m[1]} ${m[2]}` };
    }
    if (u && !seen.has(u.pkg)) {
      seen.add(u.pkg);
      out.push(u);
    }
  }
  return out;
}

/** Command that installs the security updates. Never reboots. */
export function applySecurityCmd(pm: PackageManager, updates: SecurityUpdate[]): Cmd | null {
  if (pm === 'dnf') return { argv: ['dnf', '-y', 'upgrade', '--security'] };
  if (pm === 'yum') return { argv: ['yum', '-y', 'update', '--security'] };
  if (!updates.length) return null;
  return { argv: ['apt-get', 'install', '-y', '-q', '--only-upgrade', ...updates.map((u) => u.pkg)] };
}

export const envFor = (pm: PackageManager): NodeJS.ProcessEnv => (pm === 'apt' ? { ...process.env, ...APT_ENV } : process.env);

export interface SecurityReport {
  pm: PackageManager;
  updates: SecurityUpdate[];
  /** Combined output of the list commands, for the agent and the audit log. */
  output: string;
  ok: boolean;
}

export async function securityUpdates(pm: PackageManager): Promise<SecurityReport> {
  let output = '';
  let ok = true;
  let last = '';
  for (const cmd of listSecurityCmds(pm)) {
    const r = await captureAsync(cmd, { timeout: 10 * 60_000, env: envFor(pm) });
    output += `$ ${cmd.argv.join(' ')}\n${r.output}`;
    last = r.output;
    // `dnf check-update` style exit 100 means "updates available", not failure.
    if (r.code !== 0 && r.code !== 100) ok = false;
  }
  return { pm, updates: parseSecurityUpdates(pm, last), output, ok };
}

/**
 * Whether the OS asks for a reboot after updates; null when it cannot tell.
 * apt writes /var/run/reboot-required; `needs-restarting -r` (dnf/yum utils) exits 1.
 */
export async function rebootRequired(): Promise<boolean | null> {
  if (fs.existsSync('/var/run/reboot-required')) return true;
  if (which('needs-restarting')) {
    const r = await captureAsync({ argv: ['needs-restarting', '-r'] }, { timeout: 60_000 });
    if (r.code === 0) return false;
    if (r.code === 1) return true;
    return null;
  }
  return which('apt-get') ? false : null;
}
