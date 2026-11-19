import { defineQueries, sql } from '@pulpfixer/plugin-db/api';

/**
 * `pf {{name}}` lists the queries, `pf {{name}} <query> [--param value] [--json|--csv] [--db <connection>]` runs one.
 * Write the real queries here (AGENTS.md has the rules) and replace `ping` once they exist.
 */
export default defineQueries({
  name: '{{name}}',
  summary: '{{summary}}',
  connection: '{{connection}}',
  driver: '{{driver}}',
  queries: {
    ping: {
      summary: 'Check the connection: the database server time',
      run: (db) => db.all(sql`SELECT CURRENT_TIMESTAMP AS now`),
    },
  },
});
