// Start a one-off tool in scratch/ from the template.   pf wb-new [<name>] [--dry-run]
// With no name and a terminal (the menu), it asks for one.
// Plain node on purpose: it creates tools, it is not one of the tools that make file folders.
import fs from 'node:fs';
import path from 'node:path';
import { checkName, ROOT } from '../../lib/paths.mjs';
import { ask, canAsk } from '../../lib/prompt.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--dry-run');
const taken = (n) => fs.existsSync(path.join(ROOT, 'scratch', n)) || fs.existsSync(path.join(ROOT, 'tools', n));
let name = args[0];
if (!name && canAsk()) {
  name = await ask('Name of the new tool', {
    validate: (v) => {
      if (!v) return 'a name is needed';
      try {
        checkName(v);
      } catch (e) {
        return e.message;
      }
      return taken(v) ? `"${v}" already exists (scratch/ or tools/)` : undefined;
    },
  });
  if (name === null) process.exit(130);
}
if (!name) (console.error('usage: pf wb-new <name> [--dry-run]'), process.exit(2));

try {
  checkName(name);
  const dir = path.join(ROOT, 'scratch', name);
  if (taken(name)) throw new Error(`"${name}" already exists (scratch/ or tools/)`);
  const file = path.join(dir, 'index.mjs');
  const body = `// ${name}: what this tool does, in one line.   node scratch/${name}/index.mjs [--live]
// Simulates unless --live. Inputs go in files/${name}/in, outputs come out in files/${name}/out (git never sees files/).
import { sql } from '@pulpfixer/plugin-db/api';
import { runTool } from '../../lib/tool.mjs';

await runTool(import.meta.url, async (ctx) => {
  const db = await ctx.openDb(); // writes are simulated unless --live
  try {
    ctx.log('inputs:', ctx.dirs.in);
    // const rows = await db.all(sql\`SELECT * FROM \${sql.id('table')} WHERE user_id = \${id}\`);
  } finally {
    await db.close();
  }
});
`;
  if (dry) console.log(`would create ${path.relative(ROOT, file)} and files/${name}/{in,out,logs}`);
  else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    for (const d of ['in', 'out', 'logs']) fs.mkdirSync(path.join(ROOT, 'files', name, d), { recursive: true });
    console.log(`created scratch/${name}/index.mjs and files/${name}/{in,out,logs}\nrun it: node scratch/${name}/index.mjs\nkeep it: pf wb-promote ${name} "what it does"`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
