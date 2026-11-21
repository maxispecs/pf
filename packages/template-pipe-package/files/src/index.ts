import type { Row } from '@pulpfixer/kit/io';
import { csvSink, csvSource } from '@pulpfixer/plugin-csv/api';
import { dbSink, dbSource, sql } from '@pulpfixer/plugin-db/api';
import { definePipes } from '@pulpfixer/plugin-io/api';

// What this repo was created with: the ends of the sample pipe. Change `copy` (or add pipes) freely.
const INPUT = '{{input}}' as string; // 'db' or 'csv'
const OUTPUT = '{{output}}' as string; // 'csv' or 'db'
const CONNECTION = '{{connection}}'; // the pf db connection, when an end is a database

/** What happens to each row on its way. Return a row, an array of rows, or null to drop it. */
export function shape(row: Row): Row {
  return row;
}

/**
 * `pf {{name}}` lists the pipes, `pf {{name}} <pipe> [--param value] [--dry-run] [--yes]` runs one.
 * A pipe declares its inputs and outputs (pf shows them and asks before writing) and couples them in code:
 * either `transform` (the default flow, input -> transform -> every output) or `run`. AGENTS.md has the rules.
 */
export default definePipes({
  name: '{{name}}',
  summary: '{{summary}}',
  pipes: {
    copy: {
      summary: 'Copy rows from the {{input}} input to the {{output}} output',
      params: {
        from: { required: true, help: INPUT === 'csv' ? 'the CSV file to read' : 'the table to read' },
        to: { required: true, help: OUTPUT === 'csv' ? 'the CSV file to write (it must not exist yet)' : 'the table to insert into' },
      },
      inputs: ({ from }) => ({
        source: INPUT === 'csv' ? csvSource({ path: String(from) }) : dbSource({ connection: CONNECTION, query: sql`SELECT * FROM ${sql.id(String(from))}` }),
      }),
      outputs: ({ to }) => ({
        target: OUTPUT === 'csv' ? csvSink({ path: String(to) }) : dbSink({ connection: CONNECTION, table: String(to) }),
      }),
      transform: shape,
    },
  },
});
