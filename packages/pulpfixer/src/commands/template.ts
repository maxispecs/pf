import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_NAME } from '@pulpfixer/kit/constants';
import { buildContext } from '@pulpfixer/kit/context';
import { capture, runCmd } from '@pulpfixer/kit/exec';
import { reposDir, shortHome } from '@pulpfixer/kit/suite-settings';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { ask } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, h2, termLine } from '@pulpfixer/kit/ui/text';
import { compareVersions, takeFlag, takeOption, which } from '@pulpfixer/kit/util';
import { version } from '@pulpfixer/kit/version';
import type { Command } from '@pulpfixer/kit/types';
import { BUILTIN_PLUGINS } from '../plugins/index.js';
import { builtinPackage, bundledVersion } from '../plugins/registry.js';
import { defaultOf, paramFlag, paramProblem, renderDir, renderTemplate, resolveParams, substitute, type Template, type Values, type Versions } from '../templates/render.js';
import { cachedTemplates, fetchTemplate, isTemplateName, searchTemplates, templatePackage } from '../templates/templates.js';
import { repoCommand } from './repo.js';
import { bundledPackageVersion } from './versions.js';

const USAGE = `Usage:
  pf template                            list templates (cached here and on the registry)
  pf template apply <template> [<value>] [--<param> <value>...] [--dir <path>]
                    [--dry-run] [--offline] [--no-git] [--no-repo]
                                         fetch the latest template and create a repo from it,
                                         in the suite's repos folder (pf suite config, ~/dev by default)
                                         or in --dir (relative to here)`;

const short = (v: string): string => v.replace(/^(\d+\.\d+)\.0$/, '$1');

/** Versions a template may ask for with `{{version:<package>}}`: pf itself, the kit and the built-in plugins. */
export function bundledVersions(): Versions {
  const versions: Versions = { [PACKAGE_NAME]: version(), '@pulpfixer/kit': bundledPackageVersion('@pulpfixer/kit', '@pulpfixer/kit/version') };
  for (const p of BUILTIN_PLUGINS) versions[builtinPackage(p.name)] = bundledVersion(p.name);
  return Object.fromEntries(Object.entries(versions).filter(([, v]) => !!v));
}

/** `pf template` / `pf template list`. */
export function listTemplates(): number {
  const c = out();
  const w = (s: string) => process.stdout.write(s + '\n');
  const cached = cachedTemplates();
  const remote = searchTemplates();
  const names = [...new Set([...cached.map((t) => t.name), ...(remote.templates ?? []).map((t) => t.name)])].sort();
  if (!names.length) {
    w(c.dim('no templates found.'));
  } else {
    const width = Math.max(8, ...names.map((n) => n.length));
    w(c.bold('Templates') + c.dim('  @pulpfixer/template-<name>, applied with pf template apply <name>'));
    for (const name of names) {
      const mine = cached.find((t) => t.name === name);
      const latest = remote.templates?.find((t) => t.name === name);
      const have = mine ? `v${short(mine.version)}` : 'not fetched';
      const state = mine && !mine.template
        ? c.red(`unusable: ${mine.problem}`)
        : latest && mine && compareVersions(latest.version, mine.version) > 0
          ? c.yellow(`v${short(latest.version)} on the registry`)
          : '';
      const summary = mine?.template?.summary || latest?.description || '';
      w(`  ${c.bold(name.padEnd(width))}  ${c.dim(have.padEnd(11))}${state ? `  ${state}` : ''}${summary ? `  ${c.dim(summary)}` : ''}`);
    }
  }
  if (remote.error) {
    process.stderr.write(`${badgeLabel('warning', err())} could not search the registry: ${remote.error}\n`);
    return cached.length ? 0 : 1;
  }
  return 0;
}

const fail = (msg: string, code = 1): number => {
  process.stderr.write(`${badgeLabel('error', err())} ${msg}\n`);
  return code;
};

/** The usage line of one template, from its params. */
export function applyUsage(name: string, template: Template): string {
  const [first, ...rest] = Object.entries(template.params);
  const parts = ['pf template apply', name];
  if (first) parts.push(first[1].default === undefined ? `<${first[0]}>` : `[<${first[0]}>]`);
  for (const [k, p] of rest) parts.push(p.default === undefined ? `${paramFlag(k)} <${k}>` : `[${paramFlag(k)} <${k}>]`);
  return parts.join(' ');
}

/** Read `--<param> value` flags and the positional first param out of `args` (consumed). */
export function takeParams(template: Template, args: string[]): Values {
  const given: Values = {};
  const names = Object.keys(template.params);
  for (const name of names) {
    const v = takeOption(args, paramFlag(name));
    if (v !== undefined) given[name] = v;
  }
  const first = names[0];
  if (first && !(first in given) && args[0] !== undefined && !args[0].startsWith('-')) given[first] = args.shift()!;
  return given;
}

/** Ask for the params not given, in order, with their defaults filled in. Null when cancelled. */
async function promptParams(template: Template, given: Values): Promise<Values | null> {
  const values: Values = {};
  for (const [name, def] of Object.entries(template.params)) {
    if (Object.hasOwn(given, name)) {
      values[name] = given[name]!;
      continue;
    }
    const initial = defaultOf(def, values);
    const hint = def.choices ? ` (${def.choices.join(', ')})` : def.help ? ` (${def.help})` : '';
    const answer = await ask(`${def.prompt}${hint}`, { ...(initial ? { initial } : {}), validate: (v) => paramProblem(name, def, v) });
    if (answer === null) return null;
    values[name] = answer;
  }
  return values;
}

/** Whether `dir` (or, when it does not exist yet, its nearest existing parent) is in a git work tree. */
function insideGitRepo(dir: string): boolean {
  let probe = dir;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  return capture(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: probe }).stdout.trim() === 'true';
}

/** Where the new repo goes: `--dir` (relative to the current folder), else the template's folder inside the repos folder. */
export function templateTarget(o: { cwd: string; dirOpt?: string | undefined; dir: string; reposDir: string }): string {
  return o.dirOpt ? path.resolve(o.cwd, o.dirOpt) : path.join(o.reposDir, o.dir);
}

/** A folder as it is shown and as a shell takes it: `~/dev/x` when under home, quoted when it holds odd characters. */
export function shellPath(abs: string): string {
  const shown = shortHome(abs);
  if (/^[\w@%+=:,./~-]+$/.test(shown)) return shown;
  return `'${abs.replaceAll("'", "'\\''")}'`;
}

async function applyTemplate(cwd: string, args: string[]): Promise<number> {
  const c = err();
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const offline = takeFlag(rest, '--offline');
  const noGit = takeFlag(rest, '--no-git');
  const noRepo = takeFlag(rest, '--no-repo');
  const dirOpt = takeOption(rest, '--dir');
  const name = rest.shift();
  if (!name || name.startsWith('-')) return (process.stderr.write(`${USAGE}\n`), 2);
  if (!isTemplateName(name)) return fail(`"${name}" is not a template name (lowercase letters, digits and dashes)`, 2);

  const fetched = fetchTemplate(name, { offline });
  if ('error' in fetched) return fail(fetched.error);
  const { template } = fetched;
  const from = fetched.source === 'registry' ? (fetched.previous ? `updated from v${short(fetched.previous)}` : 'latest') : `cached${fetched.note ? `; ${fetched.note}` : ''}`;
  process.stderr.write(c.dim(`template ${templatePackage(name)} v${short(fetched.version)} (${from})\n`));

  const given = takeParams(template, rest);
  if (rest.length) return fail(`unexpected ${rest.join(' ')}\n  ${c.dim('usage')} ${termLine(applyUsage(name, template), c)}`, 2);
  const tty = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const asked = tty ? await promptParams(template, given) : given;
  if (!asked) return (process.stderr.write(c.dim('cancelled, nothing was written\n')), 130);
  const resolved = resolveParams(template.params, asked);
  if ('error' in resolved) return fail(`${resolved.error}\n  ${c.dim('usage')} ${termLine(applyUsage(name, template), c)}`, 2);
  const values = resolved.values;

  const d = renderDir(template, values);
  if ('error' in d) return fail(`template ${name} is unusable: ${d.error}`);
  const base = reposDir();
  const target = templateTarget({ cwd, dirOpt, dir: d.dir, reposDir: base });
  if (!dirOpt && fs.existsSync(base) && !fs.statSync(base).isDirectory()) {
    return fail(`the repos folder ${shortHome(base)} is not a folder: change it with pf suite config set reposDir <folder>, or give --dir`);
  }
  const rendered = renderTemplate(path.join(fetched.dir, 'files'), template, values, bundledVersions());
  if ('error' in rendered) return fail(`template ${name} is unusable: ${rendered.error}`);
  const rel = dirOpt ? path.relative(cwd, target) || '.' : shortHome(target);

  const conflicts = rendered.files.filter((f) => fs.existsSync(path.join(target, ...f.path.split('/'))));
  if (conflicts.length) {
    return fail(`${rel} already has ${conflicts.map((f) => f.path).join(', ')}. Nothing was written: pick another --dir or move them away.`);
  }

  process.stderr.write(`${h2(`${dryRun ? 'Would create' : 'Creating'} ${rel}`, c)}\n`);
  for (const f of rendered.files) process.stderr.write(`  ${c.green('+')} ${f.path}\n`);
  if (!dryRun) {
    for (const f of rendered.files) {
      const file = path.join(target, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.content);
    }
  }

  if (!noGit) {
    if (!which('git')) process.stderr.write(`${badgeLabel('warning', c)} git is not on PATH: the folder is not a git repo yet\n`);
    else if (insideGitRepo(target)) process.stderr.write(c.dim('already inside a git repo, no git init\n'));
    else {
      const code = await runCmd({ argv: ['git', 'init', '--quiet'], cwd: target }, { dryRun, base: cwd });
      if (code !== 0) return code;
    }
  }

  if (!noRepo) {
    if (dryRun) process.stderr.write(`${c.dim('would run')} ${termLine(`pf repo --no-deploy  (in ${rel})`, c)}\n`);
    else {
      process.stderr.write('\n');
      const code = await repoCommand.run(buildContext(target), ['--no-deploy']);
      if (code !== 0) return code;
    }
  }

  const next = [`cd ${dirOpt ? rel : shellPath(target)}`, ...template.next].map((line) => {
    const r = substitute(line, values);
    return 'text' in r ? r.text : line;
  });
  if (!dryRun) process.stderr.write(`\n${c.dim('Next:')}\n${next.map((l) => `  ${termLine(l, c)}`).join('\n')}\n`);
  else process.stderr.write(c.dim(`\ndry run: nothing was written to ${rel}\n`));
  return 0;
}

export const templateCommand: Command = {
  name: 'template',
  summary: 'Create a repo from a template (query packages and more)',
  group: 'Tools',
  usage: 'pf template [list] | pf template apply <template> [<value>] [--<param> <value>...] [--dir <path>] [--dry-run] [--offline] [--no-git] [--no-repo]',
  async run(ctx, args) {
    const [sub, ...rest] = args;
    if (!sub || sub === 'list' || sub === 'ls') return listTemplates();
    if (sub === 'apply') return applyTemplate(ctx.cwd, rest);
    if (sub === 'help' || sub === '--help' || sub === '-h') return (process.stdout.write(`${USAGE}\n`), 0);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  },
};
