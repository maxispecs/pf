import fs from 'node:fs';
import { PACKAGE_NAME, REGISTRY_URL, pfHome } from '../constants.js';
import { userConfigPath } from '../config.js';
import { globalBinOnPath, legacyGlobal, npmrcHasCellarsAuth, pfOnPath, userNpmrc } from '../install/env.js';
import { AGENT_IDS, installedAgents, resolveAgent } from '../agent/agents.js';
import { cursorMcpPath, cursorMcpRegistered } from '../agent/adapters.js';
import { BUNDLED_LABEL } from '../skills/discover.js';
import { installedSkills, targetDir } from '../skills/registry.js';
import { loadSkills } from './skill.js';
import { out } from '../ui/palette.js';
import { reporter } from '../ui/prompt.js';
import { compareVersions, takeFlag } from '../util.js';
import { displayVersion, packageRoot } from '../version.js';
import { fetchLatest } from '../update/check.js';
import { findVersionsRoot } from './ver.js';
import type { Command } from './types.js';

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Check this machine and repo for problems',
  group: 'Tools',
  usage: 'pf doctor [--offline]',
  async run(ctx, args) {
    const rest = [...args];
    const offline = takeFlag(rest, '--offline');
    const c = out();
    const r = reporter(c);
    let fails = 0;
    const fail = (m: string) => (r.fail(m), fails++);

    process.stdout.write(c.bold('pf doctor') + '\n');

    r.step('Install');
    const major = parseInt(process.versions.node.split('.')[0]!, 10);
    if (major >= 18) r.ok(`Node ${process.versions.node}`);
    else fail(`Node ${process.versions.node}: pf needs >= 18`);
    r.ok(`pf v${displayVersion()} running from ${packageRoot()}`);

    const installs = pfOnPath();
    if (installs.length === 0) r.warn('`pf` is not on PATH (running from a checkout?). Install it: scripts/install.sh');
    for (const [i, p] of installs.entries()) {
      const tag = p.legacy ? `legacy pulpfixer ${p.version}` : p.version ? `pulpfixer ${p.version}` : 'unknown';
      if (p.legacy) fail(`${p.path} is ${tag}${i === 0 ? ' and wins on PATH' : ''}: run pf setup to replace it`);
      else r.ok(`${p.path} (${tag})${i === 0 ? '' : ' shadowed'}`);
    }
    const legacy = legacyGlobal();
    if (legacy && !installs.some((p) => p.legacy)) fail(`legacy pulpfixer ${legacy.version} is installed globally: run pf setup`);

    const bin = globalBinOnPath();
    if (bin.bin) (bin.ok ? r.ok : r.warn)(`npm global bin ${bin.bin} ${bin.ok ? 'is' : 'is not'} on PATH`);

    r.step('Registry');
    if (npmrcHasCellarsAuth()) r.ok(`auth line for ${REGISTRY_URL} in ${userNpmrc()}`);
    else r.warn(`no auth line for ${REGISTRY_URL} in ${userNpmrc()} (pf setup adds it)`);
    if (process.env.NPM_TOKEN) r.ok('NPM_TOKEN is set');
    else {
      r.warn('NPM_TOKEN is not set');
      r.info('Needed to install or update from cellars. Token from #frontend');
    }
    if (offline) r.info('registry check skipped (--offline)');
    else {
      const latest = fetchLatest(15_000);
      if (!latest.version) r.warn(`could not read ${PACKAGE_NAME} from the registry: ${latest.error}`);
      else if (compareVersions(latest.version, ctx.version) > 0) r.warn(`v${displayVersion(latest.version)} is available: run pf update`);
      else r.ok(`pf is current (registry has v${displayVersion(latest.version)})`);
    }

    r.step('Skills and agents');
    const agents = installedAgents();
    const choice = resolveAgent({ env: process.env.PF_AGENT, configured: ctx.user.agent });
    if (agents.length) r.ok(`agent CLIs: ${agents.map((a) => a.bin).join(', ')}`);
    else r.warn('no agent CLI (cursor-agent, claude, codex): pf agent and prompt-only skills cannot run');
    if (choice.unknown) fail(`agent "${choice.requested}" (${choice.source}) is not one of ${AGENT_IDS.join(', ')}: run pf agent use`);
    else if (choice.missing) fail(`agent ${choice.agent!.label} (${choice.source}) is not on PATH: run pf agent use`);
    else if (choice.agent) r.ok(`pf agent uses ${choice.agent.label} (${choice.source === 'detected' ? 'auto-detected; pf agent use sets it' : choice.source})`);
    if (agents.some((a) => a.id === 'cursor')) {
      if (cursorMcpRegistered()) r.ok(`pulpfixer MCP server registered in ${cursorMcpPath()}`);
      else r.info(`pulpfixer MCP server not in ${cursorMcpPath()} (pf agent use cursor adds it)`);
    }
    const skills = loadSkills(ctx);
    r.ok(`${skills.length} skills found (${skills.filter((s) => s.source === BUNDLED_LABEL).length} bundled with pf)`);
    const fromRegistry = installedSkills();
    r.info(`${fromRegistry.length} installed from the registry (${fromRegistry.filter((s) => s.target === 'pf').length} in ${targetDir('pf')})${fromRegistry.length ? ': pf update keeps them current' : ': pf skill available lists them'}`);

    r.step('Config');
    r.info(`${pfHome()} ${fs.existsSync(pfHome()) ? 'exists' : 'does not exist yet'}`);
    r.info(`${userConfigPath()} ${fs.existsSync(userConfigPath()) ? 'exists' : 'not created (pf setup creates it)'}`);

    r.step('Repo');
    if (!ctx.repo) r.info('not inside a repo');
    else {
      r.ok(`${ctx.repo.name} at ${ctx.repo.root}`);
      r.info(`stacks: ${ctx.stacks.map((s) => s.label).join(', ') || 'none detected'}`);
      r.info(`pf.json: ${ctx.repo.hasConfig ? Object.keys(ctx.config.commands).length + ' command(s)' : 'none (pf init creates it)'}`);
      r.info(`versions.json: ${findVersionsRoot(ctx.cwd) ? 'yes' : 'no (pf ver init sets it up)'}`);
    }

    process.stdout.write(`\n${fails ? c.red(`${fails} problem(s) found.`) : c.green('No problems found.')}\n`);
    return fails ? 1 : 0;
  },
};
