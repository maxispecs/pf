// Make a scratch tool permanent: move it to tools/ and register it with pf.   pf wb-promote <name> "<description>" [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { checkName, ROOT } from '../../lib/paths.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--dry-run');
const [name, ...rest] = args;
const description = rest.join(' ').trim();
if (!name || !description) (console.error('usage: pf wb-promote <name> "<what it does>" [--dry-run]'), process.exit(2));

try {
  checkName(name);
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
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
