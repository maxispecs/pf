import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_LINE, PACKAGE_NAME, REGISTRY_URL } from '@pulpfixer/kit/constants';
import type { Context } from '@pulpfixer/kit/context';
import { capture, runCmd } from '@pulpfixer/kit/exec';
import { buildHostLaunch, newAuditHeader, openAudit, runAudited } from '../host/agent.js';
import { instanceIdentity, parseTargets, pfHostLine, readSecrets, regionFor, sendCommandArgv, type Identity } from '../host/aws.js';
import {
  AGENT_KEY,
  DEFAULT_PREFIX,
  NPM_TOKEN,
  SECRET_SOURCES,
  defaultSecrets,
  hostConfigExists,
  hostConfigPath,
  hostDir,
  hostNpmrcPath,
  loadHostConfig,
  saveHostConfig,
  validUnit,
  type HostConfig,
  type SecretSource,
} from '../host/config.js';
import { applySecurityCmd, detectPackageManager, envFor, rebootRequired, securityUpdates } from '../host/patch.js';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { reporter } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine, usageTable } from '@pulpfixer/kit/ui/text';
import { quote, splitDashes, takeFlag, takeOption, which } from '@pulpfixer/kit/util';
import { packageRoot } from '@pulpfixer/kit/version';
import type { Command } from '@pulpfixer/kit/types';

const SUBCOMMANDS = [
  { usage: 'pf host init [init options]', summary: 'Write /etc/pulpfixer/host.json (secret names only)' },
  { usage: 'pf host login', summary: 'Check instance identity, IAM role, secret access and the agent CLI' },
  { usage: 'pf host status', summary: 'Instance, versions, pending security updates, recent runs' },
  { usage: 'pf host update [--yes]', summary: 'Install the configured pf version and update the agent CLI' },
  { usage: 'pf host patch [--apply]', summary: 'List OS security updates; --apply installs them (never reboots)' },
  { usage: 'pf host fix [--apply] <task>', summary: 'Run the agent on this host: plan-only unless --apply' },
  { usage: 'pf host install --instances i-1,i-2 | --tag K=V [init options]', summary: 'From your machine: install pf on instances via SSM' },
  { usage: 'pf host send --instances ... | --tag K=V <command> [args]', summary: 'From your machine: run status, login, update, patch or fix via SSM' },
];

/** Subcommands `pf host send` may run remotely. */
const SENDABLE = ['status', 'login', 'update', 'patch', 'fix'];

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

/** Host commands write /etc and the audit log. PF_HOST_DIR (tests, a non-root layout) skips the check. */
function needRoot(what: string): boolean {
  if (isRoot() || process.env.PF_HOST_DIR) return true;
  process.stderr.write(`${badgeLabel('error', err())} ${what} needs root (SSM Run Command runs as root; locally use sudo).\n`);
  return false;
}

function needConfig(): HostConfig | null {
  if (hostConfigExists()) return loadHostConfig();
  process.stderr.write(`${badgeLabel('error', err())} no ${hostConfigPath()}. Run ${termLine('pf host init', err())} first.\n`);
  return null;
}

function pfBin(): string {
  return which('pf') ?? path.join(packageRoot(), 'dist', 'bin', 'pf.js');
}

function timerUnits(bin: string): { file: string; contents: string }[] {
  return [
    {
      file: '/etc/systemd/system/pulpfixer-update.service',
      contents: `[Unit]\nDescription=pulpfixer: update pf and the agent CLI\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${bin} host update --yes\n`,
    },
    {
      file: '/etc/systemd/system/pulpfixer-update.timer',
      contents: `[Unit]\nDescription=Daily pulpfixer update\n\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
    },
  ];
}

/** Options shared by `init` and `install`, already removed from args. */
interface InitOptions {
  source?: SecretSource;
  prefix?: string;
  region?: string;
  services: string[];
  budget?: number;
  timer: boolean;
}

function takeInitOptions(args: string[]): InitOptions | string {
  const source = takeOption(args, '--secrets');
  if (source !== undefined && !SECRET_SOURCES.includes(source as SecretSource)) return `--secrets must be ${SECRET_SOURCES.join(' or ')}`;
  const prefix = takeOption(args, '--prefix');
  if (prefix !== undefined && !/^\/?[\w.\-/]+$/.test(prefix)) return `--prefix must look like ${DEFAULT_PREFIX}`;
  const region = takeOption(args, '--region');
  const services: string[] = [];
  for (let s = takeOption(args, '--service'); s !== undefined; s = takeOption(args, '--service')) {
    for (const unit of s.split(',').filter(Boolean)) {
      if (!validUnit(unit)) return `not a systemd unit: ${unit}`;
      services.push(unit);
    }
  }
  const budgetText = takeOption(args, '--budget');
  const budget = budgetText === undefined ? undefined : Number(budgetText);
  if (budget !== undefined && !(budget > 0)) return '--budget must be a positive number of USD';
  return {
    ...(source ? { source: source as SecretSource } : {}),
    ...(prefix ? { prefix } : {}),
    ...(region ? { region } : {}),
    services,
    ...(budget ? { budget } : {}),
    timer: takeFlag(args, '--timer'),
  };
}

/** The same options as flags again, for `pf host init` on the instance. */
function initFlags(o: InitOptions): string[] {
  return [
    ...(o.source ? ['--secrets', o.source] : []),
    ...(o.prefix ? ['--prefix', o.prefix] : []),
    ...(o.region ? ['--region', o.region] : []),
    ...o.services.flatMap((s) => ['--service', s]),
    ...(o.budget ? ['--budget', String(o.budget)] : []),
    ...(o.timer ? ['--timer'] : []),
  ];
}

async function init(args: string[], dryRun: boolean): Promise<number> {
  const c = out();
  const r = reporter(c);
  const opts = takeInitOptions(args);
  if (typeof opts === 'string') return usageError(opts);
  if (!dryRun && !needRoot('pf host init')) return 1;
  const existed = hostConfigExists();
  const current = loadHostConfig();
  const config: HostConfig = {
    ...current,
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.source || opts.prefix ? { secrets: { ...current.secrets, ...defaultSecrets(opts.source ?? 'ssm', opts.prefix ?? DEFAULT_PREFIX) } } : {}),
    ...(opts.services.length ? { services: [...new Set([...current.services, ...opts.services])] } : {}),
    ...(opts.budget ? { maxBudgetUsd: opts.budget } : {}),
  };
  process.stdout.write(c.bold('pf host init') + '\n');
  r.step('Config');
  if (dryRun) r.info(`would ${existed ? 'update' : 'write'} ${hostConfigPath()}`);
  else {
    saveHostConfig(config);
    r.ok(`${existed ? 'updated' : 'wrote'} ${hostConfigPath()}`);
  }
  for (const [env, ref] of Object.entries(config.secrets)) r.info(`${env} from ${ref.source} ${ref.name}`);
  r.info(`restartable services: ${config.services.join(', ') || 'none'}`);

  r.step('Registry');
  if (dryRun) r.info(`would write ${hostNpmrcPath()} with ${AUTH_LINE}`);
  else {
    fs.writeFileSync(hostNpmrcPath(), `${AUTH_LINE}\n`, { mode: 0o600 });
    r.ok(`${hostNpmrcPath()} reads the token from \${${NPM_TOKEN}} (no token is stored)`);
  }

  if (opts.timer) {
    r.step('Update timer');
    for (const u of timerUnits(pfBin())) {
      if (dryRun) r.info(`would write ${u.file}`);
      else fs.writeFileSync(u.file, u.contents);
    }
    for (const argv of [['systemctl', 'daemon-reload'], ['systemctl', 'enable', '--now', 'pulpfixer-update.timer']]) {
      const code = await runCmd({ argv }, { dryRun });
      if (code !== 0) {
        r.fail(`${argv.join(' ')} failed`);
        return code;
      }
    }
    if (!dryRun) r.ok('pulpfixer-update.timer runs pf host update daily');
  }
  if (!dryRun) process.stdout.write(`\nNext: ${termLine('pf host login', c)}\n`);
  return 0;
}

/** Identity, role, secret access and the agent CLI. Reads each secret once and throws the value away. */
async function login(): Promise<number> {
  const c = out();
  const r = reporter(c);
  let fails = 0;
  const fail = (m: string) => (r.fail(m), fails++);
  const config = needConfig();
  if (!config) return 1;
  process.stdout.write(c.bold('pf host login') + '\n');

  r.step('Instance');
  const id = await instanceIdentity();
  if (id) {
    r.ok(`${id.instanceId} (${id.instanceType ?? 'unknown type'}) in ${id.region}, account ${id.accountId}`);
    if (id.profileArn) r.ok(`instance role: ${id.profileArn}`);
    else fail('no instance profile: attach an IAM role that can read the pulpfixer secrets');
  } else r.warn('not an EC2 instance (IMDSv2 did not answer): using the ambient AWS credentials');
  const region = regionFor(config, id);
  if (!region) fail('no AWS region: set one with pf host init --region');

  r.step('Secrets');
  if (!which('aws')) fail('aws CLI not found: install it (dnf install awscli / apt-get install awscli)');
  else {
    const names = Object.keys(config.secrets);
    const got = readSecrets(config, names, region);
    for (const env of names) {
      const ref = config.secrets[env]!;
      const f = got.failed.find((x) => x.env === env);
      if (f) fail(`${env}: cannot read ${ref.source} ${ref.name}: ${f.error}`);
      else r.ok(`${env}: readable from ${ref.source} ${ref.name}`);
    }
  }
  if (!fs.existsSync(hostNpmrcPath())) fail(`${hostNpmrcPath()} missing: run pf host init`);

  r.step('Agent');
  const claude = capture(['claude', '--version'], { timeout: 20_000 });
  if (claude.ok) r.ok(`Claude Code ${claude.stdout.trim()}`);
  else fail('claude not found: install it with npm install -g @anthropic-ai/claude-code');
  const pm = detectPackageManager();
  if (pm) r.ok(`package manager: ${pm}`);
  else r.warn('no dnf, yum or apt-get: pf host patch is unavailable');

  process.stdout.write(fails ? `\n${c.red(`${fails} problem(s)`)}\n` : `\n${c.green('Ready.')} Try ${termLine('pf host fix "check for pending security patches"', c)}\n`);
  return fails ? 1 : 0;
}

function recentRuns(dir: string, n = 5): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .slice(-n)
      .map((f) => {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const head = JSON.parse(text.slice(0, text.indexOf('\n'))) as { startedAt?: string; mode?: string; task?: string };
        const exit = /\{"finishedAt":[^\n]*"exit":(\d+)\}\s*$/.exec(text)?.[1];
        return `${head.startedAt ?? f}  ${head.mode ?? '?'}  exit ${exit ?? 'running'}  ${(head.task ?? '').slice(0, 60)}`;
      });
  } catch {
    return [];
  }
}

async function status(ctx: Context): Promise<number> {
  const c = out();
  const r = reporter(c);
  const config = hostConfigExists() ? loadHostConfig() : null;
  process.stdout.write(c.bold('pf host status') + '\n');
  r.step('Instance');
  const id = await instanceIdentity();
  if (id) r.ok(`${id.instanceId} in ${id.region}${id.profileArn ? `, role ${id.profileArn.split('/').pop()}` : ', no role'}`);
  else r.warn('not an EC2 instance (no IMDSv2)');
  r.info(`${os.hostname()}, up ${Math.round(os.uptime() / 3600)}h`);
  r.step('pulpfixer');
  r.ok(`pf ${ctx.version}`);
  if (config) r.ok(`config ${hostConfigPath()} (pins ${config.version})`);
  else r.warn(`no ${hostConfigPath()}: run pf host init`);
  const claude = capture(['claude', '--version'], { timeout: 20_000 });
  if (claude.ok) r.ok(`Claude Code ${claude.stdout.trim()}`);
  else r.warn('claude not installed');
  r.step('Security updates');
  const pm = detectPackageManager();
  if (!pm) r.warn('no supported package manager');
  else {
    const report = await securityUpdates(pm);
    if (!report.ok) r.warn(`${pm} could not list updates (see pf host patch)`);
    else if (report.updates.length) r.warn(`${report.updates.length} pending via ${pm}: ${report.updates.map((u) => u.pkg).slice(0, 8).join(', ')}${report.updates.length > 8 ? ', ...' : ''}`);
    else r.ok(`none pending via ${pm}`);
  }
  const reboot = await rebootRequired();
  if (reboot) r.warn('a reboot is pending');
  if (config) {
    r.step('Recent agent runs');
    const runs = recentRuns(config.auditDir);
    if (runs.length) for (const line of runs) r.info(line);
    else r.info(`none in ${config.auditDir}`);
  }
  return 0;
}

async function update(yes: boolean, dryRun: boolean): Promise<number> {
  const c = out();
  const r = reporter(c);
  const config = needConfig();
  if (!config) return 1;
  if (!dryRun && !needRoot('pf host update')) return 1;
  process.stdout.write(c.bold('pf host update') + '\n');
  if (!yes && !dryRun) {
    process.stderr.write(`${badgeLabel('error', err())} pass --yes to install (this runs unattended on hosts).\n`);
    return 2;
  }
  const id = await instanceIdentity();
  const region = regionFor(config, id);
  const secrets = dryRun ? { env: {}, failed: [] } : readSecrets(config, [NPM_TOKEN], region);
  if (secrets.failed.length) {
    r.fail(`cannot read ${NPM_TOKEN}: ${secrets.failed[0]!.error}`);
    return 1;
  }
  // The token only lives in these children's env; the npmrc references ${NPM_TOKEN}.
  const env = { ...process.env, ...secrets.env, NPM_CONFIG_USERCONFIG: hostNpmrcPath() };
  r.step('pf');
  const code = await runCmd({ argv: ['npm', 'install', '-g', `${PACKAGE_NAME}@${config.version}`, '--registry', REGISTRY_URL] }, { dryRun, env });
  if (code !== 0) {
    r.fail('npm install failed');
    return code;
  }
  r.step('Skills');
  const skills = await runCmd({ argv: [pfBin(), 'skill', 'update'] }, { dryRun, env });
  if (config.updateAgent) {
    r.step('Agent');
    const agent = which('claude')
      ? await runCmd({ argv: ['claude', 'update'] }, { dryRun })
      : await runCmd({ argv: ['npm', 'install', '-g', '@anthropic-ai/claude-code@latest'] }, { dryRun, env: { ...process.env, NPM_CONFIG_USERCONFIG: hostNpmrcPath() } });
    if (agent !== 0) r.warn('the agent CLI update failed');
  }
  return skills;
}

async function patch(apply: boolean, dryRun: boolean): Promise<number> {
  const c = out();
  const r = reporter(c);
  if (apply && !dryRun && !needRoot('pf host patch --apply')) return 1;
  const pm = detectPackageManager();
  if (!pm) {
    r.fail('no dnf, yum or apt-get on this host');
    return 1;
  }
  process.stdout.write(c.bold(`pf host patch (${pm})`) + '\n');
  const report = await securityUpdates(pm);
  if (!report.ok) {
    process.stdout.write(report.output);
    r.fail(`${pm} could not list security updates`);
    return 1;
  }
  if (!report.updates.length) {
    r.ok('no pending security updates');
    return 0;
  }
  for (const u of report.updates) r.info(`${u.pkg}  ${u.advisory}`);
  const cmd = applySecurityCmd(pm, report.updates)!;
  if (!apply) {
    process.stdout.write(`\n${report.updates.length} update(s). Install them with ${termLine('pf host patch --apply', c)}\n`);
    return 0;
  }
  const code = await runCmd(cmd, { dryRun, env: envFor(pm) });
  if (code !== 0) return code;
  if (!dryRun && (await rebootRequired())) r.warn('a reboot is pending (pf never reboots)');
  return 0;
}

async function fix(ctx: Context, args: string[], apply: boolean, dryRun: boolean): Promise<number> {
  const c = err();
  const task = args.join(' ').trim();
  if (!task) return usageError('say what to fix: pf host fix "patch the openssl CVE"');
  const config = needConfig();
  if (!config) return 1;
  if (!dryRun && !needRoot('pf host fix')) return 1;
  const identity: Identity | null = await instanceIdentity();
  const mcpConfigPath = path.join(hostDir(), 'mcp.json');
  const launch = buildHostLaunch({ config, task, apply, identity, mcpConfigPath });
  process.stderr.write(`${c.dim(apply ? 'mode: apply (patches and allowlisted restarts allowed)' : 'mode: plan-only (nothing changes; rerun with --apply)')}\n`);
  if (dryRun) return runCmd({ argv: launch.argv }, { dryRun: true });

  const secrets = readSecrets(config, [AGENT_KEY], regionFor(config, identity));
  if (secrets.failed.length) {
    process.stderr.write(`${badgeLabel('error', c)} cannot read ${AGENT_KEY}: ${secrets.failed[0]!.error}\n`);
    return 1;
  }
  fs.writeFileSync(mcpConfigPath, launch.mcpJson, { mode: 0o600 });
  const header = newAuditHeader({ task, apply, identity, version: ctx.version });
  const audit = openAudit(config.auditDir, header);
  if (audit) process.stderr.write(`${c.dim(`audit log ${audit.file}`)}\n`);
  else process.stderr.write(`${badgeLabel('warning', c)} could not write the audit log in ${config.auditDir}\n`);
  // The key goes to the agent's env only. The registry token is not passed at all.
  const env: NodeJS.ProcessEnv = { ...process.env, ...secrets.env };
  delete env[NPM_TOKEN];
  return runAudited(launch.argv, env, audit);
}

/** Install pf on instances: SSM runs scripts/install.sh --host on each, as root. */
async function install(args: string[], dryRun: boolean): Promise<number> {
  const instances = takeOption(args, '--instances');
  const tag = takeOption(args, '--tag');
  const awsRegion = takeOption(args, '--aws-region');
  const opts = takeInitOptions(args);
  if (typeof opts === 'string') return usageError(opts);
  const targets = parseTargets(instances, tag);
  if (typeof targets === 'string') return usageError(targets);
  const script = path.join(packageRoot(), 'scripts', 'install.sh');
  if (!fs.existsSync(script)) {
    process.stderr.write(`${badgeLabel('error', err())} ${script} is missing from this pf install.\n`);
    return 1;
  }
  const body = fs.readFileSync(script, 'utf8');
  const commands = [
    `cat > /tmp/pf-install.sh <<'PF_INSTALL_EOF'\n${body}\nPF_INSTALL_EOF`,
    `bash /tmp/pf-install.sh --host ${initFlags(opts).map(quote).join(' ')}`.trim(),
    'rm -f /tmp/pf-install.sh',
  ];
  const region = awsRegion ?? opts.region;
  return send(sendCommandArgv({ targets, commands, comment: 'pf host install', ...(region ? { region } : {}) }), dryRun);
}

/** `pf host send <targets> <sub> [args]`: one allowlisted pf host command on instances. */
async function sendSub(args: string[], dryRun: boolean): Promise<number> {
  const instances = takeOption(args, '--instances');
  const tag = takeOption(args, '--tag');
  const region = takeOption(args, '--aws-region');
  const targets = parseTargets(instances, tag);
  if (typeof targets === 'string') return usageError(targets);
  const [sub, ...rest] = args;
  if (!sub || !SENDABLE.includes(sub)) return usageError(`send runs one of: ${SENDABLE.join(', ')}`);
  const remote = [sub, ...rest];
  if (sub === 'update' && !remote.includes('--yes')) remote.push('--yes');
  if (sub === 'fix' && !rest.filter((a) => a !== '--apply').join(' ').trim()) return usageError('say what to fix: pf host send ... fix "<task>"');
  return send(sendCommandArgv({ targets, commands: [pfHostLine(remote)], comment: `pf host ${sub}`, ...(region ? { region } : {}) }), dryRun);
}

async function send(argv: string[], dryRun: boolean): Promise<number> {
  const c = err();
  if (dryRun) return runCmd({ argv }, { dryRun: true });
  if (!which('aws')) {
    process.stderr.write(`${badgeLabel('error', c)} the aws CLI is needed to reach instances through SSM.\n`);
    return 1;
  }
  const r = capture(argv, { timeout: 60_000 });
  if (!r.ok) {
    process.stderr.write(`${badgeLabel('error', c)} ${r.stderr.trim().split('\n')[0] ?? 'aws ssm send-command failed'}\n`);
    return 1;
  }
  const id = r.stdout.trim();
  const region = argv.includes('--region') ? ` --region ${argv[argv.indexOf('--region') + 1]}` : '';
  process.stdout.write(id + '\n');
  process.stderr.write(
    `${c.dim('sent. Output per instance:')}\n  ${termLine(`aws ssm list-command-invocations --command-id ${id} --details${region}`, c)}\n` +
      `${c.dim('wait for one instance:')}\n  ${termLine(`aws ssm wait command-executed --command-id ${id} --instance-id <id>${region}`, c)}\n`,
  );
  return 0;
}

function usageError(msg: string): number {
  process.stderr.write(`${badgeLabel('error', err())} ${msg}\n`);
  return 2;
}

function help(): number {
  const c = out();
  process.stdout.write(
    `${c.bold('pf host')}: pulpfixer on servers. Instances use the IAM role for secrets; operators reach them with SSM.\n\n${usageTable(SUBCOMMANDS, c)}\n` +
      `\nInit options: --secrets ssm|secretsmanager, --prefix ${DEFAULT_PREFIX}, --region R, --service unit (repeatable), --budget usd, --timer\n`,
  );
  return 0;
}

export const hostCommand: Command = {
  name: 'host',
  summary: 'Run pf on EC2 instances: login, update, patch, and the fix agent',
  group: 'Tools',
  usage: 'pf host <init|login|status|update|patch|fix|install|send> [--dry-run]',
  async run(ctx, args) {
    const [before, after] = splitDashes([...args]);
    const dryRun = takeFlag(before, '--dry-run', '-n');
    const sub = before.shift();
    switch (sub) {
      case 'init':
        return init(before, dryRun);
      case 'login':
        return login();
      case 'status':
        return status(ctx);
      case 'update':
        return update(takeFlag(before, '--yes', '-y'), dryRun);
      case 'patch':
        return patch(takeFlag(before, '--apply'), dryRun);
      case 'fix':
      case 'run':
        return fix(ctx, [...before.filter((a) => a !== '--apply'), ...after], before.includes('--apply'), dryRun);
      case 'install':
        return install(before, dryRun);
      case 'send':
        return sendSub([...before, ...after], dryRun);
      case undefined:
      case 'help':
        return help();
      default:
        return usageError(`unknown host command "${sub}". Run pf host help.`);
    }
  },
};
