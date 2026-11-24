// Check that a saved DynamoDB connection works.   pf ddb-check [--connection=NAME]
// With no --connection and a terminal (the menu), it asks which saved connection to check.
import { sql } from '@pulpfixer/plugin-db/api';
import { CONNECTION } from '../../lib/db.mjs';
import { ask, canAsk } from '../../lib/prompt.mjs';
import { runTool } from '../../lib/tool.mjs';

const argv = process.argv.slice(2);
if (canAsk() && !argv.some((a) => a.startsWith('--connection'))) {
  const name = await ask('Saved connection to check', { default: CONNECTION });
  if (name === null) process.exit(130);
  argv.push(`--connection=${name}`);
}

await runTool(import.meta.url, async (ctx) => {
  const db = await ctx.openDb();
  try {
    const started = Date.now();
    await db.value(sql`SELECT 1`); // the DynamoDB driver turns this into a cheap ListTables call
    ctx.log(`connected to "${db.name}" (${db.dialect}) in ${Date.now() - started} ms`);
  } finally {
    await db.close();
  }
}, argv);
