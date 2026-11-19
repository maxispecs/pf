import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContext } from '@pulpfixer/kit/context';
import { allCommands } from '../src/commands/index.js';
import { applyUsage, bundledVersions, takeParams, templateCommand } from '../src/commands/template.js';
import { templatesSection } from '../src/commands/versions.js';
import { isPreset } from '../src/devcycle.js';
import { paramFlag, renderDir, renderTemplate, resolveParams, safeRelPath, substitute, validateTemplate, type Template } from '../src/templates/render.js';
import { cachedTemplate, cachedTemplates, fetchTemplate, pickTemplatePackages, readTemplateDir, templateOfPackage, templatePackage } from '../src/templates/templates.js';
import { json, mkRepo } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const demo = {
  summary: 'A demo',
  dir: 'demo-{{name}}',
  params: {
    name: { prompt: 'Name', pattern: '[a-z]+' },
    label: { prompt: 'Label', default: 'The {{name}} thing' },
    kind: { prompt: 'Kind', choices: ['a', 'b'] },
  },
  rename: { _gitignore: '.gitignore' },
  next: ['use {{name}}'],
};

const asTemplate = (v: unknown): Template => {
  const t = validateTemplate(v);
  assert.equal(typeof t, 'object', String(t));
  return t as Template;
};

/** A template cached in a fresh PF_HOME, the way `fetchTemplate` leaves it. */
function cacheDemo(files: Record<string, string> = {}, manifest: unknown = demo): string {
  const home = mkRepo();
  process.env.PF_HOME = home;
  const pkg = path.join('templates', 'node_modules', '@pulpfixer', 'template-demo');
  const all: Record<string, string> = {
    [path.join(pkg, 'package.json')]: json({ name: '@pulpfixer/template-demo', version: '1.2.0' }),
    [path.join(pkg, 'template.json')]: json(manifest),
    ...Object.fromEntries(Object.entries({ 'README.md': '# {{label}}\n', _gitignore: 'dist/\n', 'src/{{name}}.txt': 'kind {{kind}}\n', ...files }).map(([k, v]) => [path.join(pkg, 'files', k), v])),
  };
  for (const [rel, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), content);
  }
  return home;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  const tty = [process.stdin.isTTY, process.stderr.isTTY];
  const set = (s: NodeJS.ReadStream | NodeJS.WriteStream, v: boolean | undefined) => Object.defineProperty(s, 'isTTY', { value: v, configurable: true, writable: true });
  set(process.stdin, false);
  set(process.stderr, false);
  process.stdout.write = ((s: string | Uint8Array) => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (err.push(String(s)), true)) as typeof process.stderr.write;
  try {
    return { code: await fn(), stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    set(process.stdin, tty[0]);
    set(process.stderr, tty[1]);
  }
}

const apply = (cwd: string, ...args: string[]) => capture(() => templateCommand.run(buildContext(cwd), ['apply', ...args]));

test('pf template is a command, and template packages are not pinned by core', () => {
  assert.ok(allCommands().some((c) => c.name === 'template'));
  assert.ok(isPreset({ name: '@pulpfixer/template-query-package' }));
  assert.equal(templatePackage('query-package'), '@pulpfixer/template-query-package');
  assert.equal(templateOfPackage('@pulpfixer/template-query-package'), 'query-package');
  assert.equal(templateOfPackage('@pulpfixer/preset-cursor'), null);
  assert.deepEqual(
    pickTemplatePackages([{ name: '@pulpfixer/template-b', version: '1.0.0' }, { name: '@pulpfixer/plugin-db', version: '1.0.0' }, { name: '@pulpfixer/template-a', version: '2.0.0', description: 'A' }]).map((t) => t.name),
    ['a', 'b'],
  );
});

test('validateTemplate: what a template.json must hold', () => {
  const t = asTemplate(demo);
  assert.deepEqual(Object.keys(t.params), ['name', 'label', 'kind']);
  assert.equal(t.rename._gitignore, '.gitignore');
  assert.match(String(validateTemplate([])), /not an object/);
  assert.match(String(validateTemplate({ ...demo, dir: '' })), /needs a "dir"/);
  assert.match(String(validateTemplate({ ...demo, params: { 'bad-name': { prompt: 'x' } } })), /not a param name/);
  assert.match(String(validateTemplate({ ...demo, params: { name: {} } })), /needs a "prompt"/);
  assert.match(String(validateTemplate({ ...demo, params: { name: { prompt: 'x', pattern: '(' } } })), /not a valid regular expression/);
  assert.match(String(validateTemplate({ ...demo, params: { name: { prompt: 'x', choices: [] } } })), /non-empty array/);
  assert.match(String(validateTemplate({ ...demo, rename: { 'a/b': 'c' } })), /plain file names/);
  assert.match(String(validateTemplate({ ...demo, rename: { a: '..' } })), /plain file names/);
  assert.match(String(validateTemplate({ ...demo, next: [1] })), /array of strings/);
});

test('resolveParams: defaults use earlier params, values are checked', () => {
  const { params } = asTemplate(demo);
  assert.deepEqual(resolveParams(params, { name: 'abc', kind: 'a' }), { values: { name: 'abc', label: 'The abc thing', kind: 'a' } });
  assert.deepEqual(resolveParams(params, { name: 'abc', kind: 'b', label: 'Mine' }), { values: { name: 'abc', label: 'Mine', kind: 'b' } });
  const missing = resolveParams(params, { name: 'abc' });
  assert.ok('error' in missing && missing.missing === 'kind');
  assert.match((resolveParams(params, { name: 'ABC', kind: 'a' }) as { error: string }).error, /--name must match/);
  assert.match((resolveParams(params, { name: 'abc', kind: 'c' }) as { error: string }).error, /one of a, b/);
  for (const bad of ['say "hi"', "it's", 'a\\b', 'a`b', 'a{{b}}', 'two\nlines']) {
    assert.match((resolveParams(params, { name: 'abc', kind: 'a', label: bad }) as { error: string }).error, /may not contain/, bad);
  }
  assert.match((resolveParams(params, { name: 'abc', kind: 'a', other: 'x' }) as { error: string }).error, /--other is not a param/);
  assert.equal(paramFlag('productId'), '--product-id');
});

test('substitute: params, bundled versions, and unknown placeholders', () => {
  assert.deepEqual(substitute('{{ name }}@{{version:@pulpfixer/kit}}', { name: 'x' }, { '@pulpfixer/kit': '6.1.0' }), { text: 'x@6.1.0' });
  assert.match((substitute('{{nope}}', {}) as { error: string }).error, /not a param/);
  assert.match((substitute('{{version:@pulpfixer/other}}', {}, {}) as { error: string }).error, /not a package bundled/);
  assert.deepEqual(substitute('${NPM_TOKEN} {x}', {}), { text: '${NPM_TOKEN} {x}' });
  const versions = bundledVersions();
  assert.match(versions['@pulpfixer/kit'] ?? '', /^\d+\.\d+/);
  assert.match(versions['@pulpfixer/plugin-db'] ?? '', /^\d+\.\d+/);
});

test('renderTemplate: fills paths and contents, renames, refuses symlinks and escapes', () => {
  const t = asTemplate(demo);
  const values = { name: 'abc', label: 'L', kind: 'a' };
  const dir = mkRepo({ 'files/README.md': '# {{label}}', 'files/_gitignore': 'dist/', 'files/src/{{name}}.txt': '{{kind}}', 'files/bin.dat': 'a\0{{b}}' });
  const r = renderTemplate(path.join(dir, 'files'), t, values);
  assert.ok('files' in r, JSON.stringify(r));
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, String(f.content)]));
  assert.deepEqual(Object.keys(byPath).sort(), ['.gitignore', 'README.md', 'bin.dat', 'src/abc.txt']);
  assert.equal(byPath['README.md'], '# L');
  assert.equal(byPath['src/abc.txt'], 'a');
  assert.equal(byPath['bin.dat'], 'a\0{{b}}');
  assert.deepEqual(renderDir(t, values), { dir: 'demo-abc' });

  const unknown = mkRepo({ 'files/a.txt': '{{missing}}' });
  assert.match((renderTemplate(path.join(unknown, 'files'), t, values) as { error: string }).error, /a.txt: \{\{missing\}\} is not a param/);

  const linked = mkRepo({ 'files/a.txt': 'x' });
  fs.symlinkSync('/etc/hosts', path.join(linked, 'files', 'hosts'));
  assert.match((renderTemplate(path.join(linked, 'files'), t, values) as { error: string }).error, /symlink/);

  const escape = mkRepo({ 'files/{{name}}/a.txt': 'x' });
  assert.match((renderTemplate(path.join(escape, 'files'), t, { ...values, name: '..' }) as { error: string }).error, /outside the target/);
  assert.equal(safeRelPath('a/b.txt'), true);
  assert.equal(safeRelPath('../a'), false);
  assert.equal(safeRelPath('/etc/a'), false);
  assert.equal(safeRelPath('.git/config'), false);
  assert.match((renderDir({ ...t, dir: '{{name}}/x' }, values) as { error: string }).error, /one folder name/);
});

test('the cache: a fetched template is read back, an unusable one says why', () => {
  cacheDemo();
  const c = cachedTemplate('demo');
  assert.equal(c?.version, '1.2.0');
  assert.ok(c?.template);
  assert.deepEqual(cachedTemplates().map((t) => t.name), ['demo']);
  assert.deepEqual(templatesSection().rows.map((r) => [r.name, r.version, r.state]), [['demo', '1.2.0', 'ok']]);
  const offline = fetchTemplate('demo', { offline: true });
  assert.ok('template' in offline && offline.source === 'cache');
  assert.match((fetchTemplate('other', { offline: true }) as { error: string }).error, /not cached yet/);
  assert.match((fetchTemplate('Bad Name') as { error: string }).error, /not a template name/);

  cacheDemo({}, { summary: 'no dir' });
  assert.match(cachedTemplate('demo')?.problem ?? '', /needs a "dir"/);
  assert.equal(templatesSection().rows[0]!.state, 'bad');
});

test('takeParams and applyUsage follow the params', () => {
  const t = asTemplate(demo);
  const args = ['abc', '--kind', 'b', '--label=Mine'];
  assert.deepEqual(takeParams(t, args), { name: 'abc', kind: 'b', label: 'Mine' });
  assert.deepEqual(args, []);
  assert.equal(applyUsage('demo', t), 'pf template apply demo <name> [--label <label>] --kind <kind>');
});

test('pf template apply writes the rendered tree, refuses conflicts, and --dry-run writes nothing', async () => {
  cacheDemo();
  const cwd = mkRepo();
  const dry = await apply(cwd, 'demo', 'abc', '--kind', 'a', '--offline', '--dry-run', '--no-git', '--no-repo');
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /Would create demo-abc/);
  assert.match(dry.stderr, /\+ src\/abc.txt/);
  assert.equal(fs.existsSync(path.join(cwd, 'demo-abc')), false);

  const missing = await apply(cwd, 'demo', 'abc', '--offline', '--no-git', '--no-repo');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--kind is required/);
  assert.match(missing.stderr, /pf template apply demo <name>/);

  const r = await apply(cwd, 'demo', 'abc', '--kind', 'b', '--offline', '--no-git', '--no-repo');
  assert.equal(r.code, 0, r.stderr);
  const out = path.join(cwd, 'demo-abc');
  assert.equal(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), '# The abc thing\n');
  assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), 'dist/\n');
  assert.equal(fs.readFileSync(path.join(out, 'src', 'abc.txt'), 'utf8'), 'kind b\n');
  assert.match(r.stderr, /use abc/);

  const again = await apply(cwd, 'demo', 'abc', '--kind', 'b', '--offline', '--no-git', '--no-repo');
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already has .*README.md/);

  const elsewhere = await apply(cwd, 'demo', 'abc', '--kind', 'b', '--offline', '--no-git', '--no-repo', '--dir', 'other/place');
  assert.equal(elsewhere.code, 0, elsewhere.stderr);
  assert.ok(fs.existsSync(path.join(cwd, 'other', 'place', 'README.md')));

  assert.equal((await apply(cwd, 'demo', 'abc', '--kind', 'b', 'extra', '--offline')).code, 2);
  assert.equal((await capture(() => templateCommand.run(buildContext(cwd), ['nope']))).code, 2);
});

test('the query-package template renders a query package wired to this pf', () => {
  const dir = path.join(repoRoot, 'packages', 'template-query-package');
  const cached = readTemplateDir('query-package', dir);
  assert.ok(cached?.template, cached?.problem ?? 'not found');
  const t = cached.template;
  const resolved = resolveParams(t.params, { name: 'revrec', driver: 'mysql' });
  assert.ok('values' in resolved, JSON.stringify(resolved));
  assert.deepEqual(resolved.values, { name: 'revrec', summary: 'Queries on the revrec database', connection: 'revrec', driver: 'mysql' });
  assert.deepEqual(renderDir(t, resolved.values), { dir: 'query-revrec' });

  const versions = bundledVersions();
  const r = renderTemplate(path.join(dir, 'files'), t, resolved.values, versions);
  assert.ok('files' in r, JSON.stringify(r));
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, String(f.content)]));
  for (const p of ['package.json', '.gitignore', '.npmrc', 'pulpfixer.json', 'AGENTS.md', 'README.md', 'src/index.ts', 'tests/queries.test.ts', 'tsconfig.json']) assert.ok(p in byPath, p);
  assert.ok(!Object.keys(byPath).some((p) => p.startsWith('_')));

  const pkg = JSON.parse(byPath['package.json']!);
  assert.equal(pkg.name, '@pulpfixer/query-revrec');
  assert.equal(pkg.dependencies['@pulpfixer/plugin-db'], `^${versions['@pulpfixer/plugin-db']}`);
  assert.equal(pkg.dependencies['@pulpfixer/kit'], `^${versions['@pulpfixer/kit']}`);
  assert.ok(pkg.scripts['publish:cellars']);
  assert.match(byPath['.npmrc']!, /_authToken=\$\{NPM_TOKEN\}/);
  assert.match(byPath['src/index.ts']!, /connection: 'revrec'/);
  assert.match(byPath['src/index.ts']!, /driver: 'mysql'/);
  assert.equal(JSON.parse(byPath['pulpfixer.json']!).name, 'query-revrec');
  for (const [p, content] of Object.entries(byPath)) assert.doesNotMatch(content, /\{\{/, p);
});
