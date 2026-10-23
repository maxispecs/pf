import fs from 'node:fs';
import path from 'node:path';
import type { Command } from '@pulpfixer/kit/types';
import { runCmd } from '@pulpfixer/kit/exec';
import { err, out } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { confirm } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, termLine } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { cpArgv, s3Uri } from '../aws.js';
import { findObject, formatDate, formatSize, loadExchange, type ExchangeConfig, type ExchangeObject } from '../exchange.js';
import { listExchange, needAws, needBucket } from './shared.js';

type Cfg = ExchangeConfig & { bucket: string };

/** Copy one object into `dir`. Asks before replacing a local file unless `force`. */
async function download(cfg: Cfg, key: string, name: string, dir: string, opts: { force: boolean; dryRun: boolean }): Promise<number> {
  const c = err();
  const dest = path.join(dir, path.basename(name));
  if (!opts.dryRun && fs.existsSync(dest) && !opts.force) {
    if (!interactive()) {
      process.stderr.write(`${badgeLabel('error', c)} ${dest} exists. Pass --force to replace it.\n`);
      return 1;
    }
    if (!(await confirm(`${dest} exists. Replace it?`, false))) return 130;
  }
  const code = await runCmd({ argv: cpArgv(s3Uri(cfg.bucket, key), dest, cfg) }, { dryRun: opts.dryRun });
  if (code === 0 && !opts.dryRun) process.stderr.write(`${c.green('✓')} saved ${dest}\n`);
  return code;
}

function printListing(objects: ExchangeObject[]): void {
  const c = out();
  const sizes = objects.map((o) => formatSize(o.size));
  const w = Math.max(...sizes.map((s) => s.length));
  objects.forEach((o, i) => process.stdout.write(`${c.dim(formatDate(o.modified))}  ${c.dim(sizes[i]!.padStart(w))}  ${o.name}\n`));
}

export const dlCommand: Command = {
  name: 'dl',
  summary: 'List the exchange bucket (newest first) and download a file',
  group: 'AWS',
  usage: 'pf dl [name] [--out <dir>] [--force] [--list] [--dry-run]',
  async run(_ctx, args) {
    const rest = [...args];
    const dryRun = takeFlag(rest, '--dry-run', '-n');
    const force = takeFlag(rest, '--force', '-f');
    const listOnly = takeFlag(rest, '--list', '-l');
    const dir = path.resolve(takeOption(rest, '--out') ?? takeOption(rest, '-o') ?? '.');
    const c = err();

    const cfg = needBucket(loadExchange());
    if (!cfg) return 2;
    if (rest.length > 1) {
      process.stderr.write(`${badgeLabel('error', c)} one name at a time: ${termLine('pf dl <name>', c)}\n`);
      return 2;
    }
    if (!dryRun && !needAws()) return 127;
    const opts = { force, dryRun };

    // A name on a dry run needs no listing: show the copy it would make.
    if (rest[0] && dryRun) return download(cfg, cfg.prefix + rest[0].replace(/^\/+/, ''), rest[0], dir, opts);

    const objects = listExchange(cfg);
    if (!objects) return 1;
    if (objects.length === 0) {
      process.stderr.write(`${c.dim(`nothing in s3://${cfg.bucket}/${cfg.prefix} yet. Upload with`)} ${termLine('pf s3 <file>', c)}\n`);
      return 0;
    }

    if (rest[0]) {
      const m = findObject(objects, rest[0]);
      if (m.kind === 'one') return download(cfg, m.object.key, m.object.name, dir, opts);
      if (m.kind === 'none') {
        process.stderr.write(`${badgeLabel('error', c)} no file matching "${rest[0]}". Run ${termLine('pf dl', c)} to see what is there.\n`);
        return 1;
      }
      process.stderr.write(`${badgeLabel('error', c)} "${rest[0]}" matches ${m.objects.length} files, be more specific:\n`);
      for (const o of m.objects.slice(0, 10)) process.stderr.write(`  ${o.name}\n`);
      return 1;
    }

    if (listOnly || dryRun || !interactive()) {
      printListing(objects);
      return 0;
    }
    const chosen = await pick(
      `Download from ${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ''}`,
      objects.map((o) => ({ value: o, label: o.name, hint: `${formatDate(o.modified)}  ${formatSize(o.size)}` })),
      { search: objects.length > 8 },
    );
    if (!chosen) return 0;
    return download(cfg, chosen.key, chosen.name, dir, opts);
  },
};
