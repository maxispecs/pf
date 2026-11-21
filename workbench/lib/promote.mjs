// Promote a scratch tool into a repo of its own ("repo mode" of wb-promote): the plan, then the write.
// Plain node, no dependencies. The plan is pure data (what goes where) so it can be tested without touching a disk
// other than the temp folders of the test; wb-promote runs `git init` and `pf repo` afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { checkName } from './paths.mjs';

/** The helpers a tool needs next to it. Tests (*.test.mjs) stay in the workbench. */
export const LIB_FILES = ['tool.mjs', 'db.mjs', 'guard.mjs', 'paths.mjs'];

/** Packages the helpers import, with the spec the new repo asks for. */
const DEPENDENCIES = ['@pulpfixer/kit', '@pulpfixer/plugin-db', '@pulpfixer/db-dynamodb'];
const PACKAGE_DIRS = { '@pulpfixer/kit': 'kit', '@pulpfixer/plugin-db': 'plugin-db', '@pulpfixer/db-dynamodb': 'db-dynamodb' };

/** The versions the monorepo has now, as `^x.y.z`, read from `<packagesDir>/<dir>/package.json`. */
export function monorepoVersions(packagesDir) {
  const versions = {};
  for (const dep of DEPENDENCIES) {
    const file = path.join(packagesDir, PACKAGE_DIRS[dep], 'package.json');
    let version;
    try {
      version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    } catch {
      throw new Error(`cannot read the version of ${dep} (${file})`);
    }
    if (typeof version !== 'string' || !version) throw new Error(`${file} has no version`);
    versions[dep] = `^${version}`;
  }
  return versions;
}

const json = (value) => JSON.stringify(value, null, 2) + '\n';

/** The text files of the new repo (everything but the tool and the helpers, which are copied). */
export function repoFiles({ name, description, versions }) {
  const run = `node tools/${name}/index.mjs`;
  return [
    {
      path: 'package.json',
      content: json({
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        description,
        dependencies: Object.fromEntries(DEPENDENCIES.map((d) => [d, versions[d]])),
      }),
    },
    { path: 'pulpfixer.json', content: json({ name, commands: { [name]: { run, description, group: 'Tools' } } }) },
    {
      path: '.gitignore',
      content: [
        '# files/ holds inputs, outputs and logs: they can hold user data, so only the folder itself is committed',
        'files/*',
        '!files/.gitkeep',
        '',
        'node_modules/',
        '.env*',
        '.pf/',
        '.DS_Store',
        '',
      ].join('\n'),
    },
    {
      path: '.npmrc',
      content: ['@pulpfixer:registry=https://cellars.staging.pangenea.com/', '//cellars.staging.pangenea.com/:_authToken=${NPM_TOKEN}', ''].join('\n'),
    },
    {
      path: 'README.md',
      content: `# ${name}

${description}

Promoted from the pulpfixer workbench. It is a tool in the workbench's style: \`tools/${name}/index.mjs\` calls \`runTool\` (see \`lib/tool.mjs\`).

\`\`\`bash
pnpm install                  # needs NPM_TOKEN for the cellars registry (see .npmrc)
pf ${name}                    # simulates: reads run, writes are only logged
pf ${name} --live             # writes for real
\`\`\`

- **Simulation first.** Nothing changes unless you pass \`--live\`.
- **Files.** Inputs go in \`files/${name}/in\`, outputs come out in \`files/${name}/out\`, logs in \`files/${name}/logs\`. Git never sees \`files/\`: it can hold user data.
- **Secrets** never go in the repo. Database connections are \`pf db\` connections (only references to secrets are stored).
`,
    },
    { path: 'files/.gitkeep', content: '' },
  ];
}

/**
 * Work out the promotion of `<scratchRoot>/<name>` into the repo at `target` (`<reposDir>/<name>`).
 * Throws an Error with a plain message when it cannot be done. Nothing is written.
 * Returns `{ target, files: [{path, content}], copies: [{from, to}] }` (`to` relative to the target).
 */
export function planRepo({ name, description, scratchRoot, libDir, target, versions }) {
  checkName(name);
  const from = path.join(scratchRoot, name);
  if (!fs.existsSync(path.join(from, 'index.mjs'))) throw new Error(`scratch/${name}/index.mjs not found (a tool is a folder with an index.mjs)`);
  if (fs.existsSync(target)) throw new Error(`${target} already exists: pick another name, or move it away`);
  for (const f of LIB_FILES) {
    if (!fs.existsSync(path.join(libDir, f))) throw new Error(`lib/${f} is missing from the workbench`);
  }
  const text = description || `${name} (promoted from the workbench)`;
  return {
    target,
    files: repoFiles({ name, description: text, versions }),
    copies: [{ from, to: path.join('tools', name) }, ...LIB_FILES.map((f) => ({ from: path.join(libDir, f), to: path.join('lib', f) }))],
  };
}

/**
 * Write a plan. A failure part-way removes what was written (the target did not exist before), and the
 * scratch tool is only removed once everything is in place.
 */
export function writeRepo(plan, { removeFrom }) {
  try {
    fs.mkdirSync(plan.target, { recursive: true });
    for (const f of plan.files) {
      const file = path.join(plan.target, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.content);
    }
    for (const c of plan.copies) {
      const to = path.join(plan.target, c.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(c.from, to, { recursive: true, errorOnExist: true, force: false });
    }
  } catch (e) {
    fs.rmSync(plan.target, { recursive: true, force: true });
    throw e;
  }
  if (removeFrom) fs.rmSync(removeFrom, { recursive: true, force: true });
}
