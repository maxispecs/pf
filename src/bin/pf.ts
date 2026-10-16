#!/usr/bin/env node
import { main } from '../cli.js';

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`pf: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
