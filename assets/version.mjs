#!/usr/bin/env node
// major.minor versioning for a repo ("stack") and its sub-packages.
// Source of truth is versions.json at the repo root. Zero dependencies, Node >= 18.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Revision of this CLI, bumped whenever it changes. `--cli-version` prints it so the /ver skill
// can tell whether a repo's copy is older than the skill's. Copies without it count as 0.
const CLI_VERSION = 2;
const MANIFEST = 'versions.json';
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'venv', 'env', '__pycache__',
  'site-packages', 'target', 'vendor',
]);
const PY_MAX_DEPTH = 3;
const TYPES = ['node', 'python', 'skill'];
const PARTS = ['major', 'minor'];

class CliError extends Error {}

const HELP = `Usage: node scripts/version.mjs <command> [options]

With no command in a terminal, opens an interactive list: click a MINOR or MAJOR button to
bump (any key exits). Without a terminal (pipes, CI) or with --json it prints "list".

Commands:
  list                    Show stack and package versions with bump commands (static output)
  bump <target> <part>    Bump a version. <target> is "stack", a package path, or a
                          package name. <part> is "major" or "minor".
                          Bumping any package also bumps the stack minor.
  init                    Create versions.json from discovered packages, or add newly
                          discovered packages to an existing one
  sync                    Rewrite package.json / pyproject.toml versions from versions.json

Options:
  --json                  (list) machine-readable output
  --dry-run               (bump, init, sync) show changes without writing files
  --prune                 (init) drop packages from versions.json that no longer exist
  --root <dir>            repo root (default: nearest dir with versions.json, or cwd for init)
  --cli-version           print this CLI's revision number
  -h, --help              show this help

Colors are on when output is a terminal. NO_COLOR=1 disables them, FORCE_COLOR=1 forces them.
`;

// ---------- colors

function colorEnabled(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== '0';
  return Boolean(stream.isTTY) && process.env.TERM !== 'dumb';
}

function palette(stream) {
  const on = colorEnabled(stream);
  const paint = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'),
    blue: paint('34'), magenta: paint('35'), cyan: paint('36'), boldGreen: paint('1;32'), boldMagenta: paint('1;35'),
  };
}

const c = palette(process.stdout);
const cErr = palette(process.stderr);
const colorType = (type) => ({ node: c.green, python: c.blue, skill: c.yellow, stack: c.magenta })[type] ?? String;
const colorTarget = (target) => (target === 'stack' ? c.boldMagenta(target) : c.cyan(target));

// ---------- fs helpers

const exists = (file) => fs.existsSync(file);
const readText = (file) => fs.readFileSync(file, 'utf8');
const toPosix = (p) => p.split(path.sep).join('/');
const joinRel = (rel, name) => (rel ? `${rel}/${name}` : name);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (e) {
    throw new CliError(`Cannot parse ${file}: ${e.message}`);
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function listDirs(root, rel) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
}

// ---------- versions

function parseVersion(v, where) {
  const m = /^(\d+)\.(\d+)$/.exec(String(v ?? ''));
  if (!m) throw new CliError(`Invalid version "${v}" for ${where}: expected major.minor, e.g. 1.4`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function bumpVersion(v, part, where) {
  const { major, minor } = parseVersion(v, where);
  return part === 'major' ? `${major + 1}.0` : `${major}.${minor + 1}`;
}

function majorMinor(native) {
  const m = /^v?(\d+)\.(\d+)/.exec(native ?? '');
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

const toNative = (v) => `${v}.0`;

// ---------- package.json

function readPackageJson(dir) {
  const file = path.join(dir, 'package.json');
  return exists(file) ? readJson(file) : null;
}

function writeNodeVersion(dir, version, dryRun) {
  const file = path.join(dir, 'package.json');
  if (!exists(file)) return { file, status: 'missing' };
  const text = readText(file);
  const native = toNative(version);
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  const escaped = indent.replace(/\t/g, '\\t');
  // Only a key at exactly one indent level is the top-level "version".
  const re = new RegExp(`^(${escaped}"version"\\s*:\\s*")([^"]*)(")`, 'm');
  let next;
  if (re.test(text)) {
    next = text.replace(re, (_, pre, _old, post) => `${pre}${native}${post}`);
  } else {
    const data = JSON.parse(text);
    let out = data;
    if ('version' in data) data.version = native;
    else if ('name' in data) {
      out = {};
      for (const [k, v] of Object.entries(data)) {
        out[k] = v;
        if (k === 'name') out.version = native;
      }
    } else out = { version: native, ...data };
    next = JSON.stringify(out, null, indent);
    if (text.endsWith('\n')) next += '\n';
  }
  if (next === text) return { file, status: 'unchanged' };
  if (!dryRun) writeAtomic(file, next);
  return { file, status: 'updated', version: native };
}

// ---------- pyproject.toml / setup.py

const PY_SECTIONS = ['project', 'tool.poetry'];
const SETUP_VERSION_RE = /(\bversion\s*=\s*)(["'])([^"']*)\2/;
const SETUP_NAME_RE = /\bname\s*=\s*["']([^"']*)["']/;

function scanToml(text, key) {
  const lines = text.split('\n');
  const keyRe = new RegExp(`^(\\s*${key}\\s*=\\s*)(["'])([^"']*)\\2(.*)$`);
  const hits = [];
  let section = '';
  lines.forEach((line, i) => {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
    if (header) {
      section = header[1].replace(/["'\s]/g, '');
      return;
    }
    if (!PY_SECTIONS.includes(section)) return;
    const m = keyRe.exec(line);
    if (m) hits.push({ i, prefix: m[1], quote: m[2], value: m[3], rest: m[4] });
  });
  return { lines, hits };
}

function pythonManifest(dir) {
  const pyproject = path.join(dir, 'pyproject.toml');
  if (exists(pyproject)) return { file: pyproject, kind: 'pyproject' };
  const setup = path.join(dir, 'setup.py');
  if (exists(setup)) return { file: setup, kind: 'setup.py' };
  return null;
}

function readPython(dir) {
  const m = pythonManifest(dir);
  if (!m) return { name: null, version: null };
  const text = readText(m.file);
  if (m.kind === 'pyproject') {
    return {
      name: scanToml(text, 'name').hits[0]?.value ?? null,
      version: scanToml(text, 'version').hits[0]?.value ?? null,
    };
  }
  return {
    name: SETUP_NAME_RE.exec(text)?.[1] ?? null,
    version: SETUP_VERSION_RE.exec(text)?.[3] ?? null,
  };
}

function writePythonVersion(dir, version, dryRun) {
  const m = pythonManifest(dir);
  if (!m) return { file: path.join(dir, 'pyproject.toml'), status: 'missing' };
  const text = readText(m.file);
  const native = toNative(version);
  let next;
  if (m.kind === 'pyproject') {
    const { lines, hits } = scanToml(text, 'version');
    if (!hits.length) {
      const dynamic = /^\s*dynamic\s*=[^\n]*["']version["']/m.test(text);
      return { file: m.file, status: 'skipped', reason: dynamic ? 'version is dynamic' : 'no static version field' };
    }
    for (const h of hits) lines[h.i] = `${h.prefix}${h.quote}${native}${h.quote}${h.rest}`;
    next = lines.join('\n');
  } else {
    if (!SETUP_VERSION_RE.test(text)) {
      return { file: m.file, status: 'skipped', reason: 'no literal version= argument' };
    }
    next = text.replace(SETUP_VERSION_RE, (_, pre, q) => `${pre}${q}${native}${q}`);
  }
  if (next === text) return { file: m.file, status: 'unchanged' };
  if (!dryRun) writeAtomic(m.file, next);
  return { file: m.file, status: 'updated', version: native };
}

// ---------- SKILL.md (agent skills)
// The version lives in the frontmatter as `metadata:\n  version: "x.y.0"`.

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(text);
  return m ? { start: 4, end: 4 + m[1].length, body: m[1] } : null;
}

function skillVersionLine(lines) {
  const at = lines.findIndex((l) => /^metadata\s*:\s*$/.test(l));
  if (at < 0) return { at: -1, line: -1 };
  let last = at;
  for (let i = at + 1; i < lines.length && /^[ \t]+\S/.test(lines[i]); i++) {
    last = i;
    if (/^[ \t]+version\s*:/.test(lines[i])) return { at, line: i, last };
  }
  return { at, line: -1, last };
}

function readSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  if (!exists(file)) return { name: null, version: null };
  const fm = splitFrontmatter(readText(file));
  if (!fm) return { name: null, version: null };
  const lines = fm.body.split(/\r?\n/);
  const name = lines.map((l) => /^name\s*:\s*(.+?)\s*$/.exec(l)?.[1]).find(Boolean) ?? null;
  const { line } = skillVersionLine(lines);
  const raw = line >= 0 ? /version\s*:\s*(.+?)\s*$/.exec(lines[line])?.[1] : null;
  return { name: name && unquote(name), version: raw ? unquote(raw) : null };
}

function writeSkillVersion(dir, version, dryRun) {
  const file = path.join(dir, 'SKILL.md');
  if (!exists(file)) return { file, status: 'missing' };
  const text = readText(file);
  const fm = splitFrontmatter(text);
  if (!fm) return { file, status: 'skipped', reason: 'no YAML frontmatter' };
  const native = toNative(version);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = fm.body.split(/\r?\n/);
  const { at, line, last } = skillVersionLine(lines);
  const entry = `  version: "${native}"`;
  if (line >= 0) lines[line] = lines[line].replace(/^([ \t]+)version\s*:.*$/, `$1version: "${native}"`);
  else if (at >= 0) lines.splice(last + 1, 0, entry);
  else lines.push('metadata:', entry);
  const next = text.slice(0, fm.start) + lines.join(nl) + text.slice(fm.end);
  if (next === text) return { file, status: 'unchanged' };
  if (!dryRun) writeAtomic(file, next);
  return { file, status: 'updated', version: native };
}

// ---------- native manifest dispatch

function readNative(root, rel, type) {
  const dir = path.join(root, rel);
  if (type === 'python') return readPython(dir);
  if (type === 'skill') return readSkill(dir);
  const pkg = readPackageJson(dir);
  return { name: pkg?.name ?? null, version: pkg?.version ?? null };
}

function syncPackage(root, rel, type, version, dryRun) {
  const dir = path.join(root, rel);
  if (type === 'skill') return writeSkillVersion(dir, version, dryRun);
  return type === 'python' ? writePythonVersion(dir, version, dryRun) : writeNodeVersion(dir, version, dryRun);
}

function syncStack(root, version, dryRun) {
  const results = [];
  if (exists(path.join(root, 'package.json'))) results.push(writeNodeVersion(root, version, dryRun));
  if (pythonManifest(root)) {
    const r = writePythonVersion(root, version, dryRun);
    // A root pyproject without a version (e.g. a uv workspace root) is not a stack manifest.
    if (r.status !== 'skipped') results.push(r);
  }
  return results;
}

function stackNativeVersions(root) {
  const out = [];
  const pkg = readPackageJson(root);
  if (pkg?.version) out.push({ file: 'package.json', version: pkg.version });
  const py = pythonManifest(root);
  if (py) {
    const { version } = readPython(root);
    if (version) out.push({ file: path.basename(py.file), version });
  }
  return out;
}

function stackName(root) {
  return readPackageJson(root)?.name ?? (pythonManifest(root) && readPython(root).name) ?? path.basename(root);
}

// ---------- discovery

function unquote(s) {
  return s.trim().replace(/^["']|["']$/g, '');
}

function parsePnpmWorkspace(text) {
  const out = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(#|$)/.test(line)) continue;
    const clean = line.replace(/\s+#.*$/, '');
    if (/^packages\s*:/.test(clean)) {
      const inline = /\[(.*)\]/.exec(clean);
      if (inline) out.push(...inline[1].split(',').map(unquote).filter(Boolean));
      inPackages = !inline;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(clean)) {
      inPackages = false;
      continue;
    }
    const m = /^\s*-\s*(.+?)\s*$/.exec(clean);
    if (m) out.push(unquote(m[1]));
  }
  return out;
}

function workspaceGlobs(root) {
  const globs = [];
  const ws = readPackageJson(root)?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws);
  else if (Array.isArray(ws?.packages)) globs.push(...ws.packages);
  const pnpmFile = path.join(root, 'pnpm-workspace.yaml');
  if (exists(pnpmFile)) globs.push(...parsePnpmWorkspace(readText(pnpmFile)));
  return [...new Set(globs)];
}

function segmentRegex(seg) {
  const body = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`);
}

function matchDirs(root, segs, rel = '') {
  if (!segs.length) return [rel];
  const [seg, ...rest] = segs;
  if (seg === '**') {
    const out = matchDirs(root, rest, rel);
    for (const child of listDirs(root, rel)) out.push(...matchDirs(root, segs, joinRel(rel, child)));
    return out;
  }
  if (!/[*?]/.test(seg)) {
    const next = joinRel(rel, seg);
    return isDir(path.join(root, next)) ? matchDirs(root, rest, next) : [];
  }
  const re = segmentRegex(seg);
  return listDirs(root, rel)
    .filter((name) => re.test(name))
    .flatMap((name) => matchDirs(root, rest, joinRel(rel, name)));
}

function expandGlobs(root, globs) {
  const include = new Set();
  const exclude = new Set();
  for (const glob of globs) {
    const negated = glob.startsWith('!');
    const pattern = toPosix(negated ? glob.slice(1) : glob).replace(/^\.\//, '').replace(/\/+$/, '');
    const segs = pattern.split('/').filter(Boolean);
    for (const dir of matchDirs(root, segs)) (negated ? exclude : include).add(dir);
  }
  return [...include].filter((d) => d && !exclude.has(d));
}

function findPythonDirs(root, skip) {
  const out = [];
  const walk = (rel, depth) => {
    for (const name of listDirs(root, rel)) {
      const child = joinRel(rel, name);
      if (skip.has(child)) continue;
      if (pythonManifest(path.join(root, child))) {
        out.push(child);
        continue;
      }
      if (depth < PY_MAX_DEPTH) walk(child, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

function findSkillDirs(root, skip) {
  const out = [];
  const walk = (rel, depth) => {
    for (const name of listDirs(root, rel)) {
      const child = joinRel(rel, name);
      if (skip.has(child)) continue;
      if (exists(path.join(root, child, 'SKILL.md'))) {
        out.push(child);
        continue;
      }
      if (depth < PY_MAX_DEPTH) walk(child, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

function detectPackageManager(root) {
  const declared = readPackageJson(root)?.packageManager?.split('@')[0];
  if (declared) return declared;
  if (exists(path.join(root, 'pnpm-lock.yaml')) || exists(path.join(root, 'pnpm-workspace.yaml'))) return 'pnpm';
  if (exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(root, 'bun.lockb')) || exists(path.join(root, 'bun.lock'))) return 'bun';
  if (exists(path.join(root, 'package.json'))) return 'npm';
  return null;
}

function discover(root) {
  const packages = new Map();
  const nodeDirs = expandGlobs(root, workspaceGlobs(root)).filter((d) => exists(path.join(root, d, 'package.json')));
  for (const d of nodeDirs) packages.set(d, 'node');
  const skillDirs = findSkillDirs(root, new Set(nodeDirs));
  for (const d of skillDirs) packages.set(d, 'skill');
  for (const d of findPythonDirs(root, new Set([...nodeDirs, ...skillDirs]))) packages.set(d, 'python');
  return {
    packages: new Map([...packages].sort(([a], [b]) => a.localeCompare(b))),
    turbo: exists(path.join(root, 'turbo.json')),
    packageManager: detectPackageManager(root),
  };
}

// ---------- manifest

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, MANIFEST))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadManifest(root) {
  const file = path.join(root, MANIFEST);
  if (!exists(file)) throw new CliError(`No ${MANIFEST} in ${root}. Run "init" first.`);
  const data = readJson(file);
  if (!data.stack) throw new CliError(`${MANIFEST} is missing "stack"`);
  parseVersion(data.stack.version, 'stack');
  data.packages ??= {};
  for (const [rel, pkg] of Object.entries(data.packages)) {
    parseVersion(pkg.version, rel);
    if (!TYPES.includes(pkg.type)) {
      throw new CliError(`Invalid type "${pkg.type}" for ${rel} in ${MANIFEST}: expected ${TYPES.join(' or ')}`);
    }
  }
  return data;
}

function saveManifest(root, data, dryRun) {
  const packages = Object.fromEntries(Object.entries(data.packages).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify({ ...data, packages }, null, 2)}\n`;
  if (!dryRun) writeAtomic(path.join(root, MANIFEST), text);
}

function resolveTarget(root, manifest, target) {
  if (target === 'stack') return null;
  const norm = toPosix(target).replace(/^\.\//, '').replace(/\/+$/, '');
  if (manifest.packages[norm]) return norm;
  const keys = Object.keys(manifest.packages);
  const byName = keys.filter((k) => readNative(root, k, manifest.packages[k].type).name === target);
  if (byName.length === 1) return byName[0];
  const byBase = keys.filter((k) => path.posix.basename(k) === norm);
  if (byBase.length === 1 && !byName.length) return byBase[0];
  const candidates = [...new Set([...byName, ...byBase])];
  if (candidates.length > 1) {
    throw new CliError(`"${target}" is ambiguous: ${candidates.join(', ')}. Use the package path.`);
  }
  throw new CliError(`Unknown target "${target}". Run "list" to see targets.`);
}

// ---------- output helpers

// A cell is a string or { text, shown }; widths come from `text` so color codes don't skew alignment.
const cell = (text, paint = String) => ({ text: String(text), shown: paint(String(text)) });
const plainOf = (x) => (typeof x === 'object' ? x.text : String(x));
const shownOf = (x) => (typeof x === 'object' ? x.shown : String(x));

function table(rows, indent = '') {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => plainOf(r[i]).length)));
  return rows
    .map((r) => indent + r
      .map((x, i) => (i === r.length - 1 ? shownOf(x) : shownOf(x) + ' '.repeat(widths[i] - plainOf(x).length)))
      .join('  '))
    .join('\n');
}

const header = (labels) => labels.map((l) => cell(l, c.bold));

function commandCell(prefix, target, part) {
  return {
    text: `${prefix} ${target} ${part}`,
    shown: `${c.dim(prefix)} ${colorTarget(target)} ${(part === 'major' ? c.yellow : c.green)(part)}`,
  };
}

function bumpCommandPrefix(root) {
  const scripts = readPackageJson(root)?.scripts ?? {};
  const pm = detectPackageManager(root);
  const run = (name) => ({ pnpm: `pnpm ${name}`, yarn: `yarn ${name}`, bun: `bun run ${name}` })[pm] ?? `npm run ${name} --`;
  if (/version\.mjs/.test(scripts.ver ?? '')) return `${run('ver')} bump`;
  if (scripts['version:bump']) return run('version:bump');
  const self = fileURLToPath(import.meta.url);
  const rel = toPosix(path.relative(root, self));
  return `node ${rel.startsWith('..') ? self : rel} bump`;
}

function printSyncResults(root, results, dryRun) {
  for (const r of results) {
    const file = toPosix(path.relative(root, r.file)) || r.file;
    if (r.status === 'updated') {
      const verb = dryRun ? c.yellow('would update') : c.green('updated');
      console.log(`  ${verb} ${file} ${c.dim('->')} ${c.boldGreen(r.version)}`);
    } else if (r.status === 'skipped') console.log(`  ${c.yellow('skipped')} ${file} ${c.dim(`(${r.reason})`)}`);
    else if (r.status === 'missing') console.log(`  ${c.yellow('skipped')} ${file} ${c.dim('(file not found)')}`);
  }
}

function collectWarnings(root, manifest, discovered) {
  const warnings = [];
  for (const [rel, type] of discovered.packages) {
    if (!manifest.packages[rel]) warnings.push(`${rel} (${type}) is on disk but not in ${MANIFEST}. Run "init" to add it.`);
  }
  for (const [rel, pkg] of Object.entries(manifest.packages)) {
    if (!isDir(path.join(root, rel))) {
      warnings.push(`${rel} is in ${MANIFEST} but not on disk. Run "init --prune" to remove it.`);
      continue;
    }
    const native = readNative(root, rel, pkg.type).version;
    const mm = majorMinor(native);
    if (mm && mm !== pkg.version) {
      warnings.push(`${rel}: native version ${native} does not match ${pkg.version}. Run "sync" to fix.`);
    }
  }
  for (const { file, version } of stackNativeVersions(root)) {
    const mm = majorMinor(version);
    if (mm && mm !== manifest.stack.version) {
      warnings.push(`stack: root ${file} has ${version}, which does not match ${manifest.stack.version}. Run "sync" to fix.`);
    }
  }
  return warnings;
}

// ---------- commands

function cmdList(root, flags) {
  const manifest = loadManifest(root);
  const discovered = discover(root);
  const prefix = bumpCommandPrefix(root);
  const cmd = (target, part) => `${prefix} ${target} ${part}`;
  const warnings = collectWarnings(root, manifest, discovered);
  const packages = Object.entries(manifest.packages).map(([rel, pkg]) => ({
    path: rel,
    name: readNative(root, rel, pkg.type).name,
    type: pkg.type,
    version: pkg.version,
    commands: { minor: cmd(rel, 'minor'), major: cmd(rel, 'major') },
  }));

  if (flags.json) {
    const output = {
      root,
      turbo: discovered.turbo,
      packageManager: discovered.packageManager,
      stack: {
        name: stackName(root),
        version: manifest.stack.version,
        commands: { minor: cmd('stack', 'minor'), major: cmd('stack', 'major') },
      },
      packages,
      warnings,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const tooling = [discovered.turbo && 'turborepo', discovered.packageManager].filter(Boolean).join(', ');
  console.log(`${c.dim('Repo:')} ${c.bold(root)}${tooling ? ` ${c.dim(`(${tooling})`)}` : ''}\n`);
  const rows = [
    header(['TARGET', 'TYPE', 'VERSION', 'NAME']),
    [cell('stack', c.boldMagenta), cell('stack', c.magenta), cell(manifest.stack.version, c.boldMagenta), cell(stackName(root), c.dim)],
    ...packages.map((p) => [
      cell(p.path, c.cyan), cell(p.type, colorType(p.type)), cell(p.version, c.bold), cell(p.name ?? '-', c.dim),
    ]),
  ];
  console.log(table(rows));
  console.log(`\n${c.bold('Bump commands')} ${c.dim('(bumping a package also bumps the stack minor):')}`);
  const cmdRows = [
    [commandCell(prefix, 'stack', 'minor'), commandCell(prefix, 'stack', 'major')],
    ...packages.map((p) => [commandCell(prefix, p.path, 'minor'), commandCell(prefix, p.path, 'major')]),
  ];
  console.log(table(cmdRows, '  '));
  if (warnings.length) {
    console.log(`\n${c.yellow(c.bold('Warnings:'))}`);
    for (const w of warnings) console.log(`  ${c.yellow('-')} ${c.yellow(w)}`);
  }
}

// Applies a bump and writes versions.json plus native manifests. Shared by `bump` and the interactive list.
function applyBump(root, target, part, dryRun) {
  if (!PARTS.includes(part)) throw new CliError(`Invalid part "${part}": expected major or minor`);
  const manifest = loadManifest(root);
  const rel = resolveTarget(root, manifest, target);
  const changes = [];

  if (rel) {
    const pkg = manifest.packages[rel];
    const next = bumpVersion(pkg.version, part, rel);
    changes.push([rel, pkg.version, next]);
    pkg.version = next;
  }
  const stackPart = rel ? 'minor' : part;
  const nextStack = bumpVersion(manifest.stack.version, stackPart, 'stack');
  changes.push(['stack', manifest.stack.version, nextStack]);
  manifest.stack.version = nextStack;

  saveManifest(root, manifest, dryRun);
  const results = [];
  if (rel) results.push(syncPackage(root, rel, manifest.packages[rel].type, manifest.packages[rel].version, dryRun));
  results.push(...syncStack(root, nextStack, dryRun));
  return { changes, results };
}

function cmdBump(root, positional, flags) {
  const [target, part] = positional;
  if (!target || !part) throw new CliError('Usage: bump <target> <major|minor>');
  const { changes, results } = applyBump(root, target, part, flags.dryRun);

  console.log(flags.dryRun ? c.yellow('Dry run, no files written:') : c.green(`Updated ${MANIFEST}:`));
  const changeRows = changes.map(([t, from, to]) => [
    cell(t, () => colorTarget(t)), cell(from, c.dim), cell('->', c.dim), cell(to, c.boldGreen),
  ]);
  console.log(table(changeRows, '  '));
  printSyncResults(root, results, flags.dryRun);
}

// ---------- interactive list (mouse clickable MINOR / MAJOR buttons)

// Cuts a string to `max` visible characters, keeping ANSI color sequences intact.
function clipVisible(s, max) {
  let visible = 0;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end !== -1) {
        out += s.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (visible >= max) return `${out}\x1b[0m`;
    out += s[i];
    visible++;
  }
  return out;
}

// Builds the screen as lines plus the clickable button regions (1-based screen coordinates).
function buildInteractiveView(root, flags, status, columns, hover) {
  const manifest = loadManifest(root);
  const discovered = discover(root);
  const warnings = collectWarnings(root, manifest, discovered);
  const tooling = [discovered.turbo && 'turborepo', discovered.packageManager].filter(Boolean).join(', ');

  const rows = [
    { target: 'stack', type: 'stack', version: manifest.stack.version, name: stackName(root) },
    ...Object.entries(manifest.packages).map(([rel, pkg]) => ({
      target: rel, type: pkg.type, version: pkg.version, name: readNative(root, rel, pkg.type).name ?? '-',
    })),
  ];
  const wTarget = Math.max('TARGET'.length, ...rows.map((r) => r.target.length));
  const wType = Math.max('TYPE'.length, ...rows.map((r) => r.type.length));
  const wVersion = Math.max('VERSION'.length, ...rows.map((r) => r.version.length));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const center = (s, w) => pad(' '.repeat(Math.floor((w - s.length) / 2)) + s, w);
  // A version cell reads "[+] 0.10 [+]": the left [+] bumps major, the right [+] bumps minor.
  // The [+] is painted (inverse when hovered); the spacing around it stays plain.
  const plus = (r, part, base) => {
    const hot = hover?.target === r.target && hover?.part === part;
    return hot ? '\x1b[1;7m[+]\x1b[0m' : base('[+]');
  };
  const xCell = wTarget + 2 + wType + 2; // 0-based column where the version cell starts
  const xMajor = xCell; // "[+]" is 3 wide
  const xMinor = xCell + 3 + 1 + wVersion + 1;
  const wName = Math.max(0, columns - (xCell + wVersion + 8 + 2));

  const lines = [];
  const buttons = [];
  lines.push(`${c.dim('Repo:')} ${c.bold(root)}${tooling ? ` ${c.dim(`(${tooling})`)}` : ''}${flags.dryRun ? c.yellow('  dry run') : ''}`);
  lines.push(c.dim('Click [+] before the version for major, after it for minor.'));
  lines.push('');
  lines.push([
    c.bold(pad('TARGET', wTarget)), c.bold(pad('TYPE', wType)),
    c.bold(`${' '.repeat(4)}${pad('VERSION', wVersion)}${' '.repeat(4)}`), c.bold('NAME'),
  ].join('  '));
  for (const r of rows) {
    const screenRow = lines.length + 1;
    const typePaint = colorType(r.type);
    const name = wName >= 4 && r.name.length > wName ? `${r.name.slice(0, wName - 1)}…` : r.name;
    lines.push([
      (r.target === 'stack' ? c.boldMagenta : c.cyan)(pad(r.target, wTarget)),
      typePaint(pad(r.type, wType)),
      `${plus(r, 'major', c.yellow)} ${c.bold(center(r.version, wVersion))} ${plus(r, 'minor', c.green)}`,
      c.dim(name),
    ].join('  '));
    buttons.push({ row: screenRow, x1: xMajor + 1, x2: xMajor + 3, target: r.target, part: 'major' });
    buttons.push({ row: screenRow, x1: xMinor + 1, x2: xMinor + 3, target: r.target, part: 'minor' });
  }
  // Hovering a [+] previews what a click would do.
  const hovered = hover && rows.find((r) => r.target === hover.target);
  lines.push('');
  lines.push(hovered
    ? `${c.dim(`${hover.part}:`)} ${colorTarget(hovered.target)} ${c.dim(hovered.version)} ${c.dim('->')} ${c.bold(bumpVersion(hovered.version, hover.part, 'list'))}`
    : '');
  lines.push('');
  lines.push(status || '');
  lines.push(c.bold('Press any key to exit'));
  if (warnings.length) {
    lines.push('');
    lines.push(c.yellow(c.bold('Warnings:')));
    for (const w of warnings) lines.push(`  ${c.yellow('-')} ${c.yellow(w)}`);
  }
  return { lines, buttons };
}

function cmdInteractive(root, flags) {
  const out = process.stdout;
  const inp = process.stdin;
  const log = [];
  let status = '';
  let buttons = [];
  let hover = null; // { target, part } of the button under the pointer

  const render = () => {
    let lines;
    try {
      ({ lines, buttons } = buildInteractiveView(root, flags, status, out.columns || 100, hover));
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      lines = [`${c.red(c.bold('error:'))} ${e.message}`];
      buttons = [];
    }
    // Every line must fit on one screen row: a wrapped line shifts the rows below it, and the
    // button hit-boxes (computed from line index) would then sit one row off from what is drawn.
    const cols = Math.max(10, (out.columns || 100) - 1);
    const rows = out.rows || lines.length;
    const fitted = lines.slice(0, rows).map((l) => clipVisible(l, cols));
    // Overwrite in place (clear each line's tail, then the rest) so hover redraws don't flicker.
    out.write(`\x1b[H${fitted.map((l) => `${l}\x1b[K`).join('\r\n')}\x1b[J`);
  };

  const buttonAt = (x, y) => buttons.find((b) => b.row === y && x >= b.x1 && x <= b.x2);

  const setHover = (x, y) => {
    const hit = buttonAt(x, y);
    const next = hit ? { target: hit.target, part: hit.part } : null;
    if (next?.target === hover?.target && next?.part === hover?.part) return;
    hover = next;
    render();
  };

  let done = false;
  const quit = (code = 0) => {
    if (done) return;
    done = true;
    out.write('\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l');
    inp.setRawMode(false);
    inp.pause();
    for (const line of log) console.log(line);
    process.exit(code);
  };

  const click = (x, y) => {
    const hit = buttonAt(x, y);
    if (!hit) return;
    try {
      const { changes } = applyBump(root, hit.target, hit.part, flags.dryRun);
      const text = changes.map(([t, from, to]) => `${t} ${from} -> ${to}`).join(', ');
      const prefix = flags.dryRun ? 'would bump' : 'bumped';
      log.push(`${prefix} ${hit.target} ${hit.part}: ${text}`);
      status = `${c.green(prefix)} ${colorTarget(hit.target)} ${hit.part}: ${c.dim(text)}`;
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      status = `${c.red('error:')} ${e.message}`;
    }
    render();
  };

  // alt screen, hide cursor, SGR mouse reporting incl. motion (1003) so we can highlight on hover
  out.write('\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h');
  inp.setRawMode(true);
  inp.setEncoding('utf8');
  inp.resume();
  inp.on('data', (s) => {
    // SGR mouse event: ESC [ < button ; x ; y (M press/motion | m release).
    // Button 0 is a left click; bit 32 marks pointer motion (35 = moved with no button held).
    const mouse = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    // Anything that is not a mouse event is a keypress, and any key exits.
    if (s.replace(mouse, '') !== '') return quit();
    for (const m of s.matchAll(mouse)) {
      const b = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      if (b & 32) setHover(x, y);
      else if (b === 0 && m[4] === 'M') click(x, y);
    }
  });
  out.on('resize', render);
  process.on('SIGTERM', () => quit(143));
  process.on('exit', () => {
    if (!done) out.write('\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l');
  });
  render();
}

function cmdInit(root, flags) {
  const discovered = discover(root);
  const file = path.join(root, MANIFEST);
  const existing = exists(file);
  const manifest = existing ? loadManifest(root) : { stack: { version: null }, packages: {} };
  const added = [];
  const removed = [];

  if (!existing) {
    const seed = stackNativeVersions(root).map((n) => majorMinor(n.version)).find(Boolean);
    manifest.stack.version = seed ?? '0.1';
  }
  for (const [rel, type] of discovered.packages) {
    if (manifest.packages[rel]) continue;
    const version = majorMinor(readNative(root, rel, type).version) ?? '0.1';
    manifest.packages[rel] = { version, type };
    added.push([rel, type, version]);
  }
  if (flags.prune) {
    for (const rel of Object.keys(manifest.packages)) {
      if (!isDir(path.join(root, rel))) {
        removed.push(rel);
        delete manifest.packages[rel];
      }
    }
  }

  saveManifest(root, manifest, flags.dryRun);
  const verb = existing ? (flags.dryRun ? 'Would update' : 'Updated') : flags.dryRun ? 'Would create' : 'Created';
  const stackNote = existing ? '' : ` ${c.dim('(stack')} ${c.boldMagenta(manifest.stack.version)}${c.dim(')')}`;
  console.log(`${(flags.dryRun ? c.yellow : c.green)(`${verb} ${MANIFEST}`)}${stackNote}`);
  if (added.length) {
    const addedRows = added.map(([rel, type, version]) => [
      cell(rel, c.cyan), cell(type, colorType(type)), cell(version, c.bold),
    ]);
    console.log(table([header(['ADDED', 'TYPE', 'VERSION']), ...addedRows], '  '));
  } else console.log(`  ${c.dim('no new packages found')}`);
  for (const rel of removed) console.log(`  ${c.red('removed')} ${rel}`);
}

function cmdSync(root, flags) {
  const manifest = loadManifest(root);
  const results = [...syncStack(root, manifest.stack.version, flags.dryRun)];
  for (const [rel, pkg] of Object.entries(manifest.packages)) {
    if (isDir(path.join(root, rel))) results.push(syncPackage(root, rel, pkg.type, pkg.version, flags.dryRun));
  }
  const changed = results.filter((r) => r.status !== 'unchanged');
  if (!changed.length) console.log(c.green(`All native manifests already match ${MANIFEST}`));
  else printSyncResults(root, changed, flags.dryRun);
}

// ---------- main

function parseArgs(argv) {
  const flags = { json: false, dryRun: false, prune: false, help: false, cliVersion: false, root: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--prune') flags.prune = true;
    else if (a === '--cli-version') flags.cliVersion = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--root') {
      flags.root = argv[++i];
      if (!flags.root) throw new CliError('--root needs a directory');
    } else if (a.startsWith('--root=')) flags.root = a.slice('--root='.length);
    else if (a === '--') continue;
    else if (a.startsWith('-')) throw new CliError(`Unknown option ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [explicit, ...rest] = positional;
  const command = explicit ?? 'list';
  if (flags.cliVersion) {
    console.log(CLI_VERSION);
    return;
  }
  if (flags.help || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === 'init') {
    cmdInit(path.resolve(flags.root ?? process.cwd()), flags);
    return;
  }
  const root = flags.root ? path.resolve(flags.root) : findRoot(process.cwd());
  if (!root) throw new CliError(`No ${MANIFEST} found in this directory or any parent. Run "init" from the repo root.`);
  const interactive = explicit === undefined && !flags.json && process.stdin.isTTY && process.stdout.isTTY
    && process.env.TERM !== 'dumb';
  if (interactive) cmdInteractive(root, flags);
  else if (command === 'list') cmdList(root, flags);
  else if (command === 'bump') cmdBump(root, rest, flags);
  else if (command === 'sync') cmdSync(root, flags);
  else throw new CliError(`Unknown command "${command}"\n\n${HELP}`);
}

try {
  main();
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  console.error(`${cErr.red(cErr.bold('error:'))} ${e.message}`);
  process.exit(1);
}
