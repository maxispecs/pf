// Check that a saved DynamoDB connection works.   pf ddb-check [--connection=NAME]
import { sql } from '@pulpfixer/plugin-db/api';
import { runTool } from '../../lib/tool.mjs';

await runTool(import.meta.url, async (ctx) => {
  const db = await ctx.openDb();
  try {
    const started = Date.now();
    await db.value(sql`SELECT 1`); // the DynamoDB driver turns this into a cheap ListTables call
    ctx.log(`connected to "${db.name}" (${db.dialect}) in ${Date.now() - started} ms`);
  } finally {
    await db.close();
  }
});
