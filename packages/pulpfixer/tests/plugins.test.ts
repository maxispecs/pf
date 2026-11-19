import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clearDbDrivers, dbDriver } from '@pulpfixer/kit/db';
import { allCommands } from '../src/commands/index.js';
import { loadFailures, loadInstalledPlugins, loadedPlugins, registerPluginDrivers, validatePlugin } from '../src/plugins/loader.js';
import { builtinRows } from '../src/plugins/manage.js';
import { BUILTIN_PLUGINS } from '../src/plugins/index.js';
import { builtinOfPackage, builtinPackage, bundledVersion, candidatePackages, entryOf, installArgv, installedPlugins, isPluginPackage, isQueryPackage, parseSpec, pickBuiltinPackages, pickPluginPackages, pluginOfPackage, uninstallArgv } from '../src/plugins/registry.js';
import { json, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const PLUGIN_JS = (name: string, command: string, extra = '') =>
  `export default { name: ${JSON.stringify(name)}, summary: 'test plugin', ${extra} commands: [{ name: ${JSON.stringify(command)}, summary: 'hi', group: 'Tools', usage: 'pf ${command}', run: async () => { console.log('plugin says hi'); return 0; } }] };\n`;

/** A PF_HOME holding installed plugins: package name -> index.js source. */
function homeWith(plugins: Record<string, string>, listed: string[] = Object.keys(plugins)): string {
  const files: Record<string, string> = {
    'plugins/package.json': json({ name: 'pf-plugins', private: true, dependencies: Object.fromEntries(listed.map((p) => [p, '^1.0.0'])) }),
  };
  for (const [pkg, src] of Object.entries(plugins)) {
    files[`plugins/node_modules/${pkg}/package.json`] = json({ name: pkg, version: '1.2.0', type: 'module', exports: { '.': { import: './index.js' } } });
    files[`plugins/node_modules/${pkg}/index.js`] = src;
  }
  return mkRepo(files);
}

test('plugin package names: scope, own-package form, and spec parsing', () => {
  assert.equal(pluginOfPackage('@pf-plugins/jira'), 'jira');
  assert.equal(pluginOfPackage('@pf-plugins-jira/jira'), 'jira');
  assert.equal(pluginOfPackage('@pf-skills/ver'), null);
  assert.equal(pluginOfPackage('left-pad'), null);
  assert.deepEqual(candidatePackages('jira'), ['@pf-plugins/jira', '@pf-plugins-jira/jira']);
  assert.deepEqual(candidatePackages('@pf-plugins-jira/jira'), ['@pf-plugins-jira/jira']);
  assert.deepEqual(candidatePackages('../evil'), []);
  assert.deepEqual(candidatePackages('left-pad@1'), []);
  assert.deepEqual(parseSpec('jira'), { name: 'jira' });
  assert.deepEqual(parseSpec('jira@1.2'), { name: 'jira', version: '1.2' });
  assert.deepEqual(parseSpec('@pf-plugins/jira@latest'), { name: '@pf-plugins/jira' });
  assert.deepEqual(parseSpec('@pf-plugins/jira@2.0.1'), { name: '@pf-plugins/jira', version: '2.0.1' });
});

test('pickPluginPackages keeps plugin packages only, preferring the default package', () => {
  const picked = pickPluginPackages([
    { name: '@pf-plugins-jira/jira', version: '1.0.0', description: 'own' },
    { name: '@pf-plugins/jira', version: '1.1.0', description: 'default' },
    { name: '@pf-skills/ver', version: '1.0.0' },
    { name: '@pf-plugins/zed', version: '0.1.0' },
  ]);
  assert.deepEqual(picked.map((p) => [p.name, p.package]), [['jira', '@pf-plugins/jira'], ['zed', '@pf-plugins/zed']]);
});

test('entryOf follows exports, then main, then index.js', () => {
  assert.equal(entryOf({ exports: './a.js' }), './a.js');
  assert.equal(entryOf({ exports: { '.': { import: './b.js', default: './c.cjs' } } }), './b.js');
  assert.equal(entryOf({ exports: { import: './d.js' } }), './d.js');
  assert.equal(entryOf({ main: 'lib/e.js' }), 'lib/e.js');
  assert.equal(entryOf({}), 'index.js');
});

test('npm argv installs and removes inside the plugins prefix', () => {
  const home = mkRepo({});
  process.env.PF_HOME = home;
  try {
    const i = installArgv('@pf-plugins/jira', '1.2.0');
    assert.equal(i[2], '@pf-plugins/jira@1.2.0');
    assert.equal(i[i.indexOf('--prefix') + 1], path.join(home, 'plugins'));
    assert.deepEqual(uninstallArgv('@pf-plugins/jira').slice(0, 3), ['npm', 'uninstall', '@pf-plugins/jira']);
  } finally {
    delete process.env.PF_HOME;
  }
});

test('drivers and query packages install from the @pulpfixer scope under their own names', () => {
  assert.equal(pluginOfPackage('@pulpfixer/db-mysql'), 'db-mysql');
  assert.equal(pluginOfPackage('@pulpfixer/query-revrec'), 'query-revrec');
  assert.equal(pluginOfPackage('@pulpfixer/kit'), null);
  assert.equal(pluginOfPackage('@pulpfixer/plugin-aws'), null);
  assert.equal(pluginOfPackage('@pulpfixer/db-'), null);
  assert.ok(isPluginPackage('@pulpfixer/db-mysql'));
  assert.ok(!isPluginPackage('@pulpfixer/preset-cursor'));
  assert.ok(isQueryPackage('@pulpfixer/query-revrec'));
  assert.ok(!isQueryPackage('@pulpfixer/db-mysql'));
  // A query package has one possible home: it is never looked up under another scope.
  assert.deepEqual(candidatePackages('db-mysql'), ['@pulpfixer/db-mysql']);
  assert.deepEqual(candidatePackages('query-revrec'), ['@pulpfixer/query-revrec']);
  assert.deepEqual(candidatePackages('@pulpfixer/query-revrec'), ['@pulpfixer/query-revrec']);
  assert.deepEqual(candidatePackages('dbx'), ['@pf-plugins/dbx', '@pf-plugins-dbx/dbx']);
  const picked = pickPluginPackages([
    { name: '@pulpfixer/db-mysql', version: '1.0.0', description: 'driver' },
    { name: '@pulpfixer/query-revrec', version: '1.2.0' },
    { name: '@pulpfixer/kit', version: '6.8.0' },
    { name: '@pulpfixer/plugin-aws', version: '5.2.0' },
  ]);
  assert.deepEqual(picked.map((p) => [p.name, p.package]), [['db-mysql', '@pulpfixer/db-mysql'], ['query-revrec', '@pulpfixer/query-revrec']]);
});

test('plugin-db is built in and `pf db` is a command', () => {
  assert.ok(BUILTIN_PLUGINS.some((p) => p.name === 'db'));
  assert.ok(allCommands().some((c) => c.name === 'db'));
});

const DRIVER_JS = (api: string) =>
  `export default { name: 'db-fakedb', ${api} summary: 'driver', commands: [], dbDrivers: [{ id: 'fakedb', label: 'Fake', dialect: 'sqlite', forms: [{ id: 'file', label: 'File', fields: [] }], describe: () => 'x', connect: async () => ({}) }] };\n`;

test('a driver plugin needs api 2, is validated, and is registered when it loads', async () => {
  const driver = { id: 'd', label: 'D', dialect: 'sqlite', forms: [{ id: 'f', label: 'F', fields: [] }], describe: () => '', connect: async () => ({}) };
  const base = { name: 'x', commands: [] };
  assert.match(validatePlugin({ default: { ...base, dbDrivers: [driver] } }) as string, /needs "api": 2/);
  assert.match(validatePlugin({ default: { ...base, api: 2, dbDrivers: 'nope' } }) as string, /array/);
  assert.match(validatePlugin({ default: { ...base, api: 2, dbDrivers: [{ ...driver, dialect: 'oracle' }] } }) as string, /dialect/);
  assert.equal(typeof validatePlugin({ default: { ...base, api: 2, dbDrivers: [driver] } }), 'object');

  clearDbDrivers();
  process.env.PF_HOME = homeWith({ '@pulpfixer/db-fakedb': DRIVER_JS('api: 2,'), '@pulpfixer/db-old': DRIVER_JS('').replace('fakedb', 'olddb').replace('db-olddb', 'db-old') });
  try {
    await loadInstalledPlugins();
    assert.equal(dbDriver('fakedb')?.label, 'Fake');
    assert.equal(dbDriver('olddb'), undefined);
    assert.match(loadFailures().find((f) => f.package === '@pulpfixer/db-old')!.error, /needs "api": 2/);
    clearDbDrivers();
    registerPluginDrivers(loadedPlugins().map((l) => l.plugin));
    assert.ok(dbDriver('fakedb'));
  } finally {
    delete process.env.PF_HOME;
    clearDbDrivers();
    await loadInstalledPlugins();
  }
});

test('validatePlugin accepts a plugin and explains what is wrong otherwise', () => {
  const ok = { default: { name: 'x', summary: 's', commands: [{ name: 'x', run: async () => 0 }] } };
  assert.equal(typeof validatePlugin(ok), 'object');
  assert.match(validatePlugin({}) as string, /does not export a plugin/);
  assert.match(validatePlugin({ default: { commands: [] } }) as string, /no name/);
  assert.match(validatePlugin({ default: { name: 'x' } }) as string, /no commands/);
  assert.match(validatePlugin({ default: { name: 'x', commands: [{ name: 'y' }] } }) as string, /run\(\)/);
  assert.match(validatePlugin({ default: { name: 'x', api: 99, commands: [] } }) as string, /plugin API 99/);
});

test('installed plugins load from ~/.pf/plugins and add commands; failures are reported, not thrown', async () => {
  const home = homeWith(
    {
      '@pf-plugins/hello': PLUGIN_JS('hello', 'hello'),
      '@pf-plugins/broken': 'throw new Error("boom");\n',
      '@pf-plugins/aws': PLUGIN_JS('aws', 'awsclash'),
      '@pf-plugins/shadow': PLUGIN_JS('shadow', 'update'),
    },
    ['@pf-plugins/hello', '@pf-plugins/broken', '@pf-plugins/aws', '@pf-plugins/shadow', '@pf-plugins/missing'],
  );
  process.env.PF_HOME = home;
  try {
    assert.deepEqual(installedPlugins().map((p) => [p.name, p.version]), [['aws', '1.2.0'], ['broken', '1.2.0'], ['hello', '1.2.0'], ['missing', ''], ['shadow', '1.2.0']]);
    await loadInstalledPlugins(['aws']);
    assert.deepEqual(loadedPlugins().map((l) => l.plugin.name).sort(), ['hello', 'shadow']);
    const failures = Object.fromEntries(loadFailures().map((f) => [f.package, f.error]));
    assert.match(failures['@pf-plugins/broken']!, /boom/);
    assert.match(failures['@pf-plugins/aws']!, /already loaded/);
    assert.match(failures['@pf-plugins/missing']!, /not installed/);
    const names = allCommands().map((c) => c.name);
    assert.ok(names.includes('hello'));
    assert.equal(names.filter((n) => n === 'update').length, 1, 'a plugin cannot shadow a built-in command');
    assert.equal(allCommands().find((c) => c.name === 'update')!.summary.startsWith('Update pf'), true);
  } finally {
    delete process.env.PF_HOME;
    await loadInstalledPlugins();
  }
});

test('PF_NO_PLUGINS skips loading', async () => {
  process.env.PF_HOME = homeWith({ '@pf-plugins/hello': PLUGIN_JS('hello', 'hello') });
  process.env.PF_NO_PLUGINS = '1';
  try {
    await loadInstalledPlugins();
    assert.equal(loadedPlugins().length, 0);
  } finally {
    delete process.env.PF_HOME;
    delete process.env.PF_NO_PLUGINS;
  }
});

function pf(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], {
    cwd: mkRepo({}),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_HOME: home },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('pf runs an installed plugin command and `pf plugin list` shows it', () => {
  const home = homeWith({ '@pf-plugins/hello': PLUGIN_JS('hello', 'hello') });
  const run = pf(home, 'hello');
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /plugin says hi/);
  const list = pf(home, 'plugin', 'list');
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /Built in/);
  assert.match(list.out, /aws/);
  assert.match(list.out, /hello\s+v1\.2\s+loaded/);
});

test('`pf plugin list` exits 1 and names a plugin that fails to load', () => {
  const home = homeWith({ '@pf-plugins/broken': 'throw new Error("boom");\n' });
  const list = pf(home, 'plugin', 'list');
  assert.equal(list.code, 1);
  assert.match(list.out, /broken.*not loaded: boom/);
});

test('`pf plugin install` needs names and refuses packages outside the plugin scope', () => {
  const home = mkRepo({});
  assert.equal(pf(home, 'plugin', 'install').code, 1);
  const r = pf(home, 'plugin', 'install', '@other/left-pad', '--dry-run');
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /not a plugin name/);
  assert.equal(pf(home, 'plugin', 'bogus').code, 1);
});

test('built-in plugins: package names, published packages and the bundled version', () => {
  assert.equal(builtinOfPackage('@pulpfixer/plugin-aws'), 'aws');
  assert.equal(builtinOfPackage('@pulpfixer/kit'), null);
  assert.equal(builtinOfPackage('pulpfixer'), null);
  assert.equal(builtinPackage('aws'), '@pulpfixer/plugin-aws');
  const picked = pickBuiltinPackages([
    { name: '@pulpfixer/kit', version: '4.1.0' },
    { name: 'pulpfixer', version: '4.1.0' },
    { name: '@pulpfixer/plugin-zeta', version: '1.0.0' },
    { name: '@pulpfixer/plugin-aws', version: '4.0.0', description: 'AWS' },
  ]);
  assert.deepEqual(picked.map((p) => p.package), ['@pulpfixer/plugin-aws', '@pulpfixer/plugin-zeta']);
  assert.match(bundledVersion('aws'), /^\d+\.\d+\.\d+$/);
  assert.equal(bundledVersion('nope'), '');
});

test('builtinRows pairs bundled plugins with the registry and adds ones this pf lacks', () => {
  const rows = builtinRows(
    [
      { name: 'aws', summary: 'AWS', bundled: '4.0.0' },
      { name: 'git', summary: 'Git', bundled: '1.0.0' },
    ],
    [
      { name: 'aws', package: '@pulpfixer/plugin-aws', version: '4.1.0', description: 'AWS' },
      { name: 'jira', package: '@pulpfixer/plugin-jira', version: '1.0.0', description: 'Jira' },
    ],
  );
  assert.deepEqual(rows, [
    { name: 'aws', summary: 'AWS', bundled: '4.0.0', published: '4.1.0' },
    { name: 'git', summary: 'Git', bundled: '1.0.0', published: '' },
    { name: 'jira', summary: 'Jira', bundled: '', published: '1.0.0' },
  ]);
});
