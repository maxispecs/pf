#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printLost } from '@pulpfixer/kit/ui/lost';
import { err } from '@pulpfixer/kit/ui/palette';
import { setPackageRoot } from '@pulpfixer/kit/version';
import { main } from '../cli.js';

setPackageRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    printLost();
    process.stderr.write(`${err().bold(err().red('pf'))}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
