// Make a scratch tool permanent.
// With nothing given and a terminal (the menu), it asks which tool, where it goes and what it does.
//   pf wb-promote <name> "<description>" [--dry-run]         move it to tools/ and register it with pf
//   pf wb-promote <name> --repo ["<description>"] [--dry-run] [--no-git] [--no-repo]
//                                                            make it a repo of its own in the suite's repos folder
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkName, ROOT } from '../../lib/paths.mjs';
import { ask, canAsk, choose } from '../../lib/prompt.mjs';
import { monorepoVersions, planRepo, writeRepo } from '../../lib/promote.mjs';

const USAGE = 'usage: pf wb-promote <name> "<what it does>" [--dry-run]\n       pf wb-promote <name> --repo ["<what it does>"] [--dry-run] [--no-git] [--no-repo]';

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('--'));
const flag = (f) => argv.includes(f);
const dry = flag('--dry-run');
let repoMode = flag('--repo');
const unknown = argv.filter((a) => a.startsWith('--') && !['--dry-run', '--repo', '--no-git', '--no-repo'].includes(a));
let [name, ...rest] = args;
let description = rest.join(' ').trim();
if (unknown.length) (console.error(`unknown option ${unknown[0]}\n${USAGE}`), process.exit(2));

// From the menu (a terminal, nothing given): pick the scratch tool, where it goes and what it does.
if (!name && canAsk()) {
  const scratch = path.join(ROOT, 'scratch');
  const tools = fs.existsSync(scratch)
    ? fs.readdirSync(scratch, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(scratch, d.name, 'index.mjs'))).map((d) => d.name).sort()
    : [];
  if (!tools.length) (console.error('no tool in scratch/ to promote (pf wb-new <name> starts one)'), process.exit(1));
  name = tools.length === 1 ? tools[0] : await choose('Which scratch tool?', tools);
  if (name === null) process.exit(130);
  const where = await choose(`Where does "${name}" go?`, [
    { value: 'tools', label: 'tools/ here, registered as a pf command' },
    { value: 'repo', label: 'a repo of its own in the repos folder' },
  ]);
  if (where === null) process.exit(130);
  repoMode = where === 'repo';
  description =
    (await ask(repoMode ? 'What it does (optional)' : 'What it does', { validate: (v) => (!v && !repoMode ? 'a description is needed' : undefined) })) ?? null;
  if (description === null) process.exit(130);
}

if (!name || (!repoMode && !description)) (console.error(USAGE), process.exit(2));
if (!repoMode && (flag('--no-git') || flag('--no-repo'))) (console.error(`--no-git and --no-repo only go with --repo\n${USAGE}`), process.exit(2));

/** `~/dev/x` for a folder under home. */
const shown = (kit, p) => kit.shortHome(p);

async function promoteToRepo() {
  checkName(name);
  if (!fs.existsSync(path.join(ROOT, 'scratch', name, 'index.mjs'))) throw new Error(`scratch/${name}/index.mjs not found (a tool is a folder with an index.mjs)`);
  const kit = await import('@pulpfixer/kit/suite-settings'); // the built kit: run pnpm build after a kit change
  const where = kit.newRepoPath(name);
  if ('error' in where) throw new Error(where.error);
  const plan = planRepo({
    name,
    description,
    scratchRoot: path.join(ROOT, 'scratch'),
    libDir: path.join(ROOT, 'lib'),
    target: where.path,
    versions: monorepoVersions(path.join(ROOT, '..', 'packages')),
  });
  const base = path.dirname(plan.target);
  if (fs.existsSync(base) && !fs.statSync(base).isDirectory()) {
    throw new Error(`the repos folder ${shown(kit, base)} is not a folder: pf suite config set reposDir <folder>`);
  }

  const lines = [...plan.copies.map((c) => `${c.to}  (from ${path.relative(ROOT, c.from)})`), ...plan.files.map((f) => f.path)];
  console.log(`${dry ? 'would create' : 'creating'} ${shown(kit, plan.target)}:\n${lines.map((l) => `  + ${l}`).join('\n')}`);
  if (dry) {
    console.log(`would then remove scratch/${name}, run git init${flag('--no-git') ? ' (skipped)' : ''} and pf repo --no-deploy${flag('--no-repo') ? ' (skipped)' : ''}`);
    console.log(`files/${name}/ stays here: it can hold user data, copy it yourself if the tool needs it`);
    return;
  }

  writeRepo(plan, { removeFrom: path.join(ROOT, 'scratch', name) });
  console.log(`\nmoved scratch/${name} into ${shown(kit, plan.target)}. files/${name}/ was left here (it can hold user data).`);

  if (!flag('--no-git')) {
    const r = spawnSync('git', ['init', '--quiet'], { cwd: plan.target, stdio: 'inherit' });
    if (r.status !== 0) console.error('git init failed: run it yourself in the new folder');
  }
  if (!flag('--no-repo')) {
    const r = spawnSync('pf', ['repo', '--no-deploy'], { cwd: plan.target, stdio: 'inherit' });
    if (r.error || r.status !== 0) console.error('pf repo --no-deploy did not finish: run it yourself in the new folder');
  }
  console.log(`\nNext:\n  cd ${shown(kit, plan.target)}\n  pnpm install\n  pf ${name}`);
}

function promoteToTools() {
  const from = path.join(ROOT, 'scratch', name);
  const to = path.join(ROOT, 'tools', name);
  if (!fs.existsSync(path.join(from, 'index.mjs'))) throw new Error(`scratch/${name}/index.mjs not found (a tool is a folder with an index.mjs)`);
  if (fs.existsSync(to)) throw new Error(`tools/${name} already exists`);

  const manifestPath = path.join(ROOT, 'pulpfixer.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.commands ??= {};
  if (manifest.commands[name]) throw new Error(`pulpfixer.json already has a command "${name}"`);
  manifest.commands[name] = { run: `node tools/${name}/index.mjs`, description, group: 'Tools' };

  if (dry) console.log(`would move scratch/${name} to tools/${name} and register "pf ${name}": ${description}`);
  else {
    fs.renameSync(from, to);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`moved to tools/${name}; registered as: pf ${name}\nIt is now tracked by git (see README to exclude it). Its files stay in files/${name}.`);
  }
}

try {
  checkName(name);
  if (repoMode) await promoteToRepo();
  else promoteToTools();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
