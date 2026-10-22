import fs from 'node:fs';
import os from 'node:os';
import type { Tool, ToolResult } from '../agent/tools.js';
import { captureAsync, formatCmd, type Cmd } from '../exec.js';
import { which } from '../util.js';
import { instanceIdentity } from './aws.js';
import { validUnit, type HostConfig } from './config.js';
import { applySecurityCmd, detectPackageManager, envFor, rebootRequired, securityUpdates } from './patch.js';

export interface HostToolOptions {
  config: HostConfig;
  /** Started with --apply: write tools may change the host. Otherwise they only describe what they would do. */
  apply: boolean;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const fail = (text: string): ToolResult => ({ ok: false, text });
const PACKAGE_NAME = /^[a-zA-Z0-9][\w.+:-]*$/;

async function run(cmd: Cmd, timeout = 60_000, env?: NodeJS.ProcessEnv): Promise<{ code: number; text: string }> {
  const r = await captureAsync(cmd, { timeout, ...(env ? { env } : {}) });
  const body = r.output.trimEnd();
  return {
    code: r.code,
    text: `$ ${formatCmd(cmd)}\nexit code ${r.code}${r.timedOut ? ' (timed out)' : ''}${body ? `\n${r.truncated ? '[output trimmed to the last part]\n' : ''}${body}` : ''}`,
  };
}

function osName(): string {
  const text = fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : '';
  return /^PRETTY_NAME="?([^"\n]*)"?/m.exec(text)?.[1] ?? `${os.type()} ${os.release()}`;
}

function planOnly(action: string): ToolResult {
  return {
    ok: true,
    text: `Plan-only run: nothing was changed. Would ${action}.\nPut this in your report; an operator reruns with --apply to do it.`,
  };
}

/** Tools for `pf host fix`. They expose curated host facts and two guarded actions, never a shell. */
export function hostTools(opts: HostToolOptions): Tool[] {
  const { config, apply } = opts;
  return [
    {
      name: 'pf_host_status',
      description: 'Facts about this instance: identity, OS, uptime, load, disk, memory, failed systemd units, whether a reboot is pending, and the run mode (plan-only or apply).',
      inputSchema: obj(),
      readOnly: true,
      async run() {
        const id = await instanceIdentity();
        const lines = [
          `mode: ${apply ? 'apply (changes allowed through pf_host_patch / pf_host_restart)' : 'plan-only (no changes)'}`,
          `instance: ${id ? `${id.instanceId} ${id.instanceType ?? ''} in ${id.region}` : 'not EC2 or IMDS unavailable'}`,
          `os: ${osName()}`,
          `uptime: ${Math.round(os.uptime() / 3600)}h, load ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`,
          `memory: ${Math.round(os.freemem() / 2 ** 20)} MiB free of ${Math.round(os.totalmem() / 2 ** 20)} MiB`,
          `package manager: ${detectPackageManager() ?? 'none found'}`,
          `reboot pending: ${String(await rebootRequired())}`,
          `restartable services: ${config.services.join(', ') || 'none configured'}`,
        ];
        const df = await run({ argv: ['df', '-h', '/'] });
        const failed = which('systemctl') ? await run({ argv: ['systemctl', '--failed', '--no-legend', '--no-pager'] }) : null;
        return { ok: true, text: [...lines, '', df.text, ...(failed ? ['', failed.text] : [])].join('\n') };
      },
    },
    {
      name: 'pf_host_security_updates',
      description: 'List pending OS security updates (dnf, yum or apt) with their advisories. Changes nothing except refreshing the package index.',
      inputSchema: obj(),
      readOnly: true,
      async run() {
        const pm = detectPackageManager();
        if (!pm) return fail('No supported package manager (dnf, yum or apt-get) on this host.');
        const r = await securityUpdates(pm);
        const head = r.updates.length
          ? [`${r.updates.length} security update(s) via ${pm}:`, ...r.updates.map((u) => `- ${u.pkg}  (${u.advisory})`)]
          : [`No pending security updates via ${pm}.`];
        return { ok: r.ok, text: [...head, '', r.output.trimEnd()].join('\n') };
      },
    },
    {
      name: 'pf_host_package',
      description: 'Installed version of one OS package (rpm or dpkg), to check it against an advisory or CVE.',
      inputSchema: obj({ name: { type: 'string', description: 'Package name, e.g. openssl' } }, ['name']),
      readOnly: true,
      async run(_ctx, input) {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!PACKAGE_NAME.test(name)) return fail('name must be a package name');
        const cmd: Cmd = which('rpm') ? { argv: ['rpm', '-q', name] } : { argv: ['dpkg-query', '-W', name] };
        const r = await run(cmd);
        return { ok: r.code === 0, text: r.text };
      },
    },
    {
      name: 'pf_host_service',
      description: 'systemd status of one unit, plus its recent journal lines.',
      inputSchema: obj(
        {
          unit: { type: 'string', description: 'Unit name, e.g. nginx.service' },
          lines: { type: 'number', description: 'Journal lines, default 100, at most 500' },
        },
        ['unit'],
      ),
      readOnly: true,
      async run(_ctx, input) {
        const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
        if (!validUnit(unit)) return fail('unit must be a systemd unit name');
        if (!which('systemctl')) return fail('systemd is not available on this host.');
        const n = Math.min(500, Math.max(1, Math.floor(typeof input.lines === 'number' ? input.lines : 100)));
        const status = await run({ argv: ['systemctl', 'status', unit, '--no-pager', '--lines=0'] });
        const journal = await run({ argv: ['journalctl', '-u', unit, '-n', String(n), '--no-pager', '-q'] });
        return { ok: true, text: `${status.text}\n\n${journal.text}` };
      },
    },
    {
      name: 'pf_host_patch',
      description:
        'Install pending OS security updates (dnf/yum --security, or the apt -security packages). Never reboots. In a plan-only run it reports what it would do instead.',
      inputSchema: obj(),
      readOnly: false,
      async run() {
        const pm = detectPackageManager();
        if (!pm) return fail('No supported package manager (dnf, yum or apt-get) on this host.');
        const report = await securityUpdates(pm);
        const cmd = applySecurityCmd(pm, report.updates);
        if (!report.updates.length || !cmd) return { ok: true, text: 'No pending security updates. Nothing to do.' };
        if (!apply) return planOnly(`run ${formatCmd(cmd)} for ${report.updates.length} update(s): ${report.updates.map((u) => u.pkg).join(', ')}`);
        const r = await run(cmd, 30 * 60_000, envFor(pm));
        const reboot = await rebootRequired();
        return { ok: r.code === 0, text: `${r.text}\n\nreboot pending: ${String(reboot)} (pf never reboots; tell the operator)` };
      },
    },
    {
      name: 'pf_host_restart',
      description: 'Restart one systemd unit from the configured allowlist (see pf_host_status). In a plan-only run it reports what it would do instead.',
      inputSchema: obj({ unit: { type: 'string', description: 'Unit from the allowlist' } }, ['unit']),
      readOnly: false,
      async run(_ctx, input) {
        const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
        if (!validUnit(unit)) return fail('unit must be a systemd unit name');
        if (!config.services.includes(unit)) {
          return fail(`${unit} is not in the restart allowlist (${config.services.join(', ') || 'empty'}). An operator adds it with pf host init --service ${unit}.`);
        }
        if (!apply) return planOnly(`run systemctl restart ${unit}`);
        const r = await run({ argv: ['systemctl', 'restart', unit] }, 5 * 60_000);
        const after = await run({ argv: ['systemctl', 'is-active', unit] });
        return { ok: r.code === 0 && after.code === 0, text: `${r.text}\n\n${after.text}` };
      },
    },
  ];
}
