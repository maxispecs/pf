import fs from 'node:fs';
import path from 'node:path';
import { findVersionsRoot, resolveVerCli } from '../commands/ver.js';
import type { Context } from '@pulpfixer/kit/context';
import { detectDocs } from '@pulpfixer/kit/detect/docs';
import { detectStaging } from '@pulpfixer/kit/detect/deploy';
import { candidates } from '@pulpfixer/kit/detect/resolve';
import { TASKS, type Task } from '@pulpfixer/kit/detect/stacks';
import { captureAsync, formatCmd, withArgs, type Cmd } from '@pulpfixer/kit/exec';
import { discoverSkills, type Skill } from '../skills/discover.js';

export interface ToolResult {
  ok: boolean;
  text: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** Changes nothing, so agent CLIs may run it without asking. */
  readOnly: boolean;
  run(ctx: Context, input: Record<string, unknown>): Promise<ToolResult>;
}

/** Tasks the agent can run. `dev` keeps running, so it is listed but never run. */
export const RUNNABLE_TASKS: Task[] = ['build', 'test', 'lint', 'install'];

const STEP_TIMEOUT = 30 * 60_000;

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const fail = (text: string): ToolResult => ({ ok: false, text });

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rootOf(ctx: Context): string {
  return ctx.repo?.root ?? ctx.workdir;
}

async function runCaptured(cmd: Cmd, base: string, timeout = STEP_TIMEOUT): Promise<{ code: number; text: string }> {
  const r = await captureAsync(cmd, { timeout });
  const head = `$ ${formatCmd(cmd, base)}\nexit code ${r.code}${r.timedOut ? ' (timed out)' : ''}`;
  const body = r.output.trimEnd();
  return { code: r.code, text: `${head}${body ? `\n${r.truncated ? '[output trimmed to the last part]\n' : ''}${body}` : ''}` };
}

export function loadAgentSkills(ctx: Context): Skill[] {
  return discoverSkills(ctx.repo?.root ?? null, ctx.user);
}

export function findSkill(ctx: Context, name: string): Skill | undefined {
  const n = name.replace(/^\//, '');
  return loadAgentSkills(ctx).find((s) => s.name === n);
}

/** Text of a skill for the agent: where it lives (to read its scripts) and its SKILL.md. */
export function skillText(skill: Skill): string {
  const body = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
  return `Skill "${skill.name}" from ${skill.source}. Directory: ${skill.dir}\nPaths in it are relative to that directory.\n\n${body}`;
}

/** What pf resolved for this repo, as plain text. */
export function commandsText(ctx: Context): string {
  if (!ctx.repo) return `Not inside a repo (${ctx.cwd}). Repo commands are unavailable.`;
  const lines: string[] = [`Repo ${ctx.repo.name} at ${ctx.repo.root}`, `Stacks: ${ctx.stacks.map((s) => s.label).join(', ') || 'none detected'}`];
  if (ctx.workdir !== ctx.repo.root) lines.push(`Commands run in ${ctx.workdir}`);
  lines.push('', 'Tasks (first is used, others are alternatives):');
  for (const t of TASKS) {
    const list = candidates(t, ctx);
    const note = t === 'dev' ? ' [long-running: not available through pf_run]' : '';
    if (list.length === 0) lines.push(`- ${t}: none found`);
    else lines.push(`- ${t}: ${list.map((c) => `${formatCmd(c.cmd, ctx.workdir)} (${c.source})`).join(' | ')}${note}`);
  }
  const custom = Object.entries(ctx.config.commands).filter(([n]) => !(TASKS as string[]).includes(n));
  if (custom.length) {
    lines.push('', 'pf.json commands:');
    for (const [n, c] of custom) lines.push(`- ${n}: ${c.run}${c.description ? ` (${c.description})` : ''}`);
  }
  const docs = detectDocs(ctx);
  lines.push('', `Docs site: ${docs.length ? formatCmd(docs[0]!.cmd, ctx.workdir) : 'none found'}`);
  const staging = detectStaging(ctx);
  lines.push(`Staging deploy: ${staging.steps.length ? `${staging.steps.length} step(s), see pf_deploy_staging` : 'none found'}`);
  lines.push(`Versioning: ${findVersionsRoot(ctx.cwd) ? 'versions.json (use pf_versions / pf_bump)' : 'not set up'}`);
  return lines.join('\n');
}

export const TOOLS: Tool[] = [
  {
    name: 'pf_commands',
    description:
      'List what pf resolved for this repo: stacks, the dev/build/test/lint/install commands, pf.json commands, docs site, staging deploy and versioning. Call this first instead of guessing commands.',
    inputSchema: obj(),
    readOnly: true,
    run: async (ctx) => ({ ok: true, text: commandsText(ctx) }),
  },
  {
    name: 'pf_run',
    description:
      'Run one of the repo\'s resolved tasks (build, test, lint or install) and return the exit code and the end of its output. Use it to check your changes. `dev` is not available because it keeps running.',
    inputSchema: obj(
      {
        task: { type: 'string', enum: RUNNABLE_TASKS, description: 'Task to run' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments passed to the command' },
      },
      ['task'],
    ),
    readOnly: false,
    async run(ctx, input) {
      if (!ctx.repo) return fail('Not inside a repo.');
      const task = str(input, 'task') as Task | undefined;
      if (!task || !RUNNABLE_TASKS.includes(task)) return fail(`task must be one of: ${RUNNABLE_TASKS.join(', ')}`);
      const list = candidates(task, ctx);
      if (list.length === 0) return fail(`No ${task} command found in this repo. The user can add one to pf.json: { "commands": { "${task}": { "run": "..." } } }`);
      const args = Array.isArray(input.args) ? input.args.filter((a): a is string => typeof a === 'string') : [];
      const cmd = withArgs(list[0]!.cmd, args);
      const r = await runCaptured({ ...cmd, cwd: cmd.cwd ?? ctx.workdir }, ctx.workdir);
      return { ok: r.code === 0, text: r.text };
    },
  },
  {
    name: 'pf_versions',
    description: 'List module and stack versions (major.minor) from versions.json.',
    inputSchema: obj(),
    readOnly: true,
    async run(ctx) {
      const root = findVersionsRoot(ctx.cwd);
      if (!root) return fail('Versioning is not set up (no versions.json). The user can run `pf ver init`.');
      const r = await runCaptured({ argv: [process.execPath, resolveVerCli(), 'list', '--root', root], cwd: root }, rootOf(ctx), 60_000);
      return { ok: r.code === 0, text: r.text };
    },
  },
  {
    name: 'pf_bump',
    description:
      'Bump a module version after changing it: minor for normal changes, major only for breaking changes. Bumping a module also bumps the stack minor. Never edit versions in manifests by hand.',
    inputSchema: obj(
      {
        module: { type: 'string', description: '"stack", a package path or a package name (see pf_versions)' },
        level: { type: 'string', enum: ['minor', 'major'] },
      },
      ['module', 'level'],
    ),
    readOnly: false,
    async run(ctx, input) {
      const root = findVersionsRoot(ctx.cwd);
      if (!root) return fail('Versioning is not set up (no versions.json). The user can run `pf ver init`.');
      const module = str(input, 'module');
      const level = str(input, 'level');
      if (!module) return fail('module is required');
      if (level !== 'minor' && level !== 'major') return fail('level must be "minor" or "major"');
      const r = await runCaptured({ argv: [process.execPath, resolveVerCli(), 'bump', module, level, '--root', root], cwd: root }, rootOf(ctx), 60_000);
      return { ok: r.code === 0, text: r.text };
    },
  },
  {
    name: 'pf_deploy_staging',
    description:
      'Deploy to staging (production is never targeted). Without confirm it only returns the plan. Show the plan to the user and call again with confirm: true only after they agree.',
    inputSchema: obj({ confirm: { type: 'boolean', description: 'Run the plan. Only after the user agreed.' } }),
    readOnly: false,
    async run(ctx, input) {
      if (!ctx.repo) return fail('Not inside a repo.');
      const root = ctx.repo.root;
      const plan = detectStaging(ctx);
      const skipped = plan.skipped.map((s) => `skipped ${s}`);
      if (plan.steps.length === 0) {
        return fail([...skipped, 'No staging target found. The user can add one to pf.json: { "commands": { "deploy:staging": { "run": "..." } } }'].join('\n'));
      }
      const steps = plan.steps.map((s, i) => `${i + 1}. ${formatCmd(s.cmd, root)}  (${s.source})`);
      if (input.confirm !== true) {
        return {
          ok: true,
          text: ['Staging deploy plan (nothing was run):', ...steps, ...skipped, '', 'Ask the user to confirm, then call pf_deploy_staging with confirm: true.'].join('\n'),
        };
      }
      const out: string[] = [];
      for (const s of plan.steps) {
        const r = await runCaptured({ ...s.cmd, cwd: s.cmd.cwd ?? root }, root);
        out.push(r.text);
        if (r.code !== 0) return fail([...out, 'Deploy stopped at the failing step.'].join('\n\n'));
      }
      return { ok: true, text: [...out, 'Staging deploy finished.'].join('\n\n') };
    },
  },
  {
    name: 'pf_skills',
    description: 'List the skills available to pf (bundled with pf, the repo\'s and the user\'s), with what each is for.',
    inputSchema: obj(),
    readOnly: true,
    async run(ctx) {
      const skills = loadAgentSkills(ctx);
      if (!skills.length) return { ok: true, text: 'No skills found.' };
      return { ok: true, text: skills.map((s) => `- ${s.name} [${s.source}]: ${s.description}`).join('\n') };
    },
  },
  {
    name: 'pf_skill',
    description: 'Read a skill: its SKILL.md instructions and the directory holding its scripts. Call it before doing a task a skill covers, then follow it.',
    inputSchema: obj({ name: { type: 'string', description: 'Skill name, from pf_skills' } }, ['name']),
    readOnly: true,
    async run(ctx, input) {
      const name = str(input, 'name');
      if (!name) return fail('name is required');
      const skill = findSkill(ctx, name);
      if (!skill) return fail(`No skill named "${name}". Call pf_skills for the list.`);
      return { ok: true, text: skillText(skill) };
    },
  },
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
