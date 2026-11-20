// Where things live. Everything a tool reads or writes goes under files/<tool>/, which git never sees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** A tool name is a folder name: letters, digits, dot, dash, underscore. Nothing that can climb out of files/. */
export function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) {
    throw new Error(`"${name}" is not a valid tool name (letters, digits, . _ - ; no slashes)`);
  }
  return name;
}

/** files/<tool>/{in,out,logs}, created on first use. */
export function fileDirs(name) {
  const base = path.join(ROOT, 'files', checkName(name));
  const dirs = { base, in: path.join(base, 'in'), out: path.join(base, 'out'), logs: path.join(base, 'logs') };
  for (const d of [dirs.in, dirs.out, dirs.logs]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}
