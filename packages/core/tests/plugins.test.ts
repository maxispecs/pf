import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allCommands } from '../src/commands/index.js';
import { loadFailures, loadInstalledPlugins, loadedPlugins, validatePlugin } from '../src/plugins/loader.js';
import { candidatePackages, entryOf, installArgv, installedPlugins, parseSpec, pickPluginPackages, pluginOfPackage, uninstallArgv } from '../src/plugins/registry.js';
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
