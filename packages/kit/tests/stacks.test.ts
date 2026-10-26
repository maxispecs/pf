import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectStacks, justRecipes, makeTargets, type StackInfo, type Task } from '../src/detect/stacks.js';
import { detectLocalCli } from '../src/detect/localcli.js';
import { json, lines, mkRepo } from './helpers.js';

const get = (stacks: StackInfo[], id: string) => stacks.find((s) => s.id === id);
const first = (s: StackInfo | undefined, task: Task) =>
  lines([...(s?.scripts[task] ?? []), ...(s?.defaults[task] ?? [])])[0];

test('node: manager from packageManager, lockfile, default', () => {
  const a = detectStacks(mkRepo({ 'package.json': json({ packageManager: 'yarn@4.0.0', scripts: { dev: 'x' } }) }));
  assert.equal(get(a, 'node')?.manager, 'yarn');
  const b = detectStacks(mkRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '' }));
  assert.equal(get(b, 'node')?.manager, 'pnpm');
  const c = detectStacks(mkRepo({ 'package.json': '{}', 'bun.lock': '' }));
  assert.equal(get(c, 'node')?.manager, 'bun');
  const d = detectStacks(mkRepo({ 'package.json': '{}' }));
  assert.equal(get(d, 'node')?.manager, 'npm');
});

test('node: scripts become tasks, the npm placeholder test script is ignored', () => {
  const s = get(
    detectStacks(
      mkRepo({
        'package.json': json({ scripts: { dev: 'vite', build: 'vite build', test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' } }),
        'pnpm-lock.yaml': '',
      }),
    ),
    'node',
  )!;
  assert.equal(first(s, 'dev'), 'pnpm run dev');
  assert.equal(first(s, 'build'), 'pnpm run build');
  assert.equal(first(s, 'test'), undefined);
  assert.equal(first(s, 'lint'), 'pnpm run lint');
  assert.equal(first(s, 'install'), 'pnpm install');
});

test('node: start is a fallback for dev', () => {
  const s = get(detectStacks(mkRepo({ 'package.json': json({ scripts: { start: 'node .' } }) })), 'node')!;
  assert.equal(first(s, 'dev'), 'npm run start');
});

test('python: uv, poetry, pip commands', () => {
  const uv = get(detectStacks(mkRepo({ 'pyproject.toml': '[project]\ndependencies=["fastapi"]\n[tool.uv]\n', 'uv.lock': '' })), 'python')!;
  assert.equal(uv.manager, 'uv');
  assert.equal(first(uv, 'dev'), 'uv run fastapi dev');
  assert.equal(first(uv, 'install'), 'uv sync');
  const poetry = get(detectStacks(mkRepo({ 'pyproject.toml': '[tool.poetry]\nname="x"\n[tool.pytest.ini_options]\n[tool.ruff]\n', 'poetry.lock': '' })), 'python')!;
  assert.equal(first(poetry, 'test'), 'poetry run pytest');
  assert.equal(first(poetry, 'lint'), 'poetry run ruff check .');
  const pip = get(detectStacks(mkRepo({ 'requirements.txt': 'django\n', 'manage.py': '' })), 'python')!;
  assert.equal(first(pip, 'dev'), 'python3 manage.py runserver');
  assert.equal(first(pip, 'install'), 'python3 -m pip install -r requirements.txt');
});

test('go, rust, swift', () => {
  const go = get(detectStacks(mkRepo({ 'go.mod': 'module x\n' })), 'go')!;
  assert.equal(first(go, 'dev'), 'go run .');
  assert.equal(first(go, 'test'), 'go test ./...');
  assert.equal(first(go, 'lint'), 'go vet ./...');
  const goLint = get(detectStacks(mkRepo({ 'go.mod': 'module x\n', '.golangci.yml': '' })), 'go')!;
  assert.equal(first(goLint, 'lint'), 'golangci-lint run');
  const rust = get(detectStacks(mkRepo({ 'Cargo.toml': '[package]\n' })), 'rust')!;
  assert.equal(first(rust, 'dev'), 'cargo run');
  assert.equal(first(rust, 'lint'), 'cargo clippy');
  assert.equal(first(get(detectStacks(mkRepo({ 'Package.swift': '' })), 'swift'), 'build'), 'swift build');
});

test('java: maven and gradle, wrapper preferred', () => {
  const mvn = get(detectStacks(mkRepo({ 'pom.xml': '<project>spring-boot</project>', mvnw: '' })), 'maven')!;
  assert.equal(first(mvn, 'dev'), './mvnw spring-boot:run');
  assert.equal(first(mvn, 'build'), './mvnw package');
  const gradle = get(detectStacks(mkRepo({ 'build.gradle.kts': 'plugins { id("org.springframework.boot") }', gradlew: '' })), 'gradle')!;
  assert.equal(first(gradle, 'dev'), './gradlew bootRun');
  assert.equal(first(gradle, 'test'), './gradlew test');
});

test('dotnet: dev needs a project file, a lone solution still builds', () => {
  const proj = get(detectStacks(mkRepo({ 'App.csproj': '' })), 'dotnet')!;
  assert.equal(first(proj, 'dev'), 'dotnet watch run');
  const sln = get(detectStacks(mkRepo({ 'App.sln': '' })), 'dotnet')!;
  assert.equal(first(sln, 'dev'), undefined);
  assert.equal(first(sln, 'build'), 'dotnet build');
});

test('ruby, php, elixir', () => {
  const rb = get(detectStacks(mkRepo({ Gemfile: '', 'bin/rails': '', spec: '' })), 'ruby')!;
  assert.equal(first(rb, 'dev'), 'bin/rails server');
  const php = get(detectStacks(mkRepo({ 'composer.json': json({ scripts: { test: 'phpunit' } }), artisan: '' })), 'php')!;
  assert.equal(first(php, 'test'), 'composer run test');
  assert.equal(first(php, 'dev'), 'php artisan serve');
  const ex = get(detectStacks(mkRepo({ 'mix.exs': 'defp deps do [{:phoenix, "~> 1.7"}] end' })), 'elixir')!;
  assert.equal(first(ex, 'dev'), 'mix phx.server');
});

test('make and just targets map to tasks', () => {
  assert.deepEqual(makeTargets('.PHONY: dev\ndev:\n\techo\nbuild: deps\nVAR := x\n'), ['dev', 'build']);
  assert.deepEqual(justRecipes('set shell := ["bash"]\ndev:\n  echo\ntest arg="x":\n  echo\n'), ['dev', 'test']);
  const make = get(detectStacks(mkRepo({ Makefile: 'serve:\n\techo\nsetup:\n\techo\n' })), 'make')!;
  assert.equal(first(make, 'dev'), 'make serve');
  assert.equal(first(make, 'install'), 'make setup');
  const just = get(detectStacks(mkRepo({ justfile: 'build:\n  echo\n' })), 'just')!;
  assert.equal(first(just, 'build'), 'just build');
});

test('docker compose is a dev default', () => {
  const s = get(detectStacks(mkRepo({ 'compose.yaml': 'services: {}\n' })), 'compose')!;
  assert.equal(first(s, 'dev'), 'docker compose up');
});

test('an empty directory has no stacks', () => {
  assert.deepEqual(detectStacks(mkRepo({})), []);
});

const ADMIN_COMPOSER = json({
  require: { 'cakephp/cakephp': '4.4.*' },
  'require-dev': { 'cakephp/cakephp-codesniffer': '^4.5', 'phpunit/phpunit': '^9.3' },
  scripts: { 'docker:start': 'x' },
});

test('php: CakePHP app gets server, phpunit, codesniffer and composer install', () => {
  const s = get(detectStacks(mkRepo({ 'composer.json': ADMIN_COMPOSER, 'bin/cake': '', src: '', tests: '', 'phpunit.xml.dist': '' })), 'php')!;
  assert.equal(s.label, 'PHP (CakePHP)');
  assert.equal(first(s, 'dev'), 'bin/cake server');
  assert.equal(first(s, 'test'), 'vendor/bin/phpunit');
  assert.match(first(s, 'lint')!, /^vendor\/bin\/phpcs --colors -p --standard=vendor\/cakephp\/cakephp-codesniffer\/CakePHP src tests$/);
  assert.equal(first(s, 'install'), 'composer install');
  assert.equal(first(s, 'build'), undefined);
});

test('php: composer scripts beat framework defaults', () => {
  const s = get(
    detectStacks(mkRepo({ 'composer.json': json({ scripts: { dev: 'x', test: 'x', 'cs-check': 'x', stan: 'x' } }), artisan: '' })),
    'php',
  )!;
  assert.equal(s.label, 'PHP (Laravel)');
  assert.deepEqual(lines(s.scripts.lint!), ['composer run cs-check', 'composer run stan']);
  assert.equal(first(s, 'dev'), 'composer run dev');
  assert.equal(first(s, 'test'), 'composer run test');
  assert.deepEqual(lines(s.defaults.dev!), ['php artisan serve']);
});

test('php: plain repos use the built-in server and the tools they set up', () => {
  const web = get(detectStacks(mkRepo({ 'composer.json': '{}', 'public/index.php': '' })), 'php')!;
  assert.equal(first(web, 'dev'), 'php -S localhost:8000 -t public');
  assert.equal(first(web, 'test'), undefined);
  const tools = get(
    detectStacks(mkRepo({ 'composer.json': json({ 'require-dev': { 'pestphp/pest': '*', 'laravel/pint': '*', 'phpstan/phpstan': '*' } }) })),
    'php',
  )!;
  assert.equal(first(tools, 'test'), 'vendor/bin/pest');
  assert.deepEqual(lines(tools.defaults.lint!), ['vendor/bin/pint --test', 'vendor/bin/phpstan analyse']);
  const phpcs = get(detectStacks(mkRepo({ 'composer.json': '{}', 'phpcs.xml': '' })), 'php')!;
  assert.equal(first(phpcs, 'lint'), 'vendor/bin/phpcs');
});

const LOCAL_CLI = {
  a: '#!/usr/bin/env bash\n',
  'cli/run': '#!/usr/bin/env bash\n',
  'cli/commands/dev.sh': '#!/usr/bin/env bash\n# desc: docker dev environment\n# usage: ./a dev\n',
  'cli/commands/deploy/staging.sh': '#!/usr/bin/env bash\n# desc: roll staging\n# usage: ./a deploy:staging -y   skip the prompt\n',
  'cli/commands/ssh.sh': '# desc: shell in\n',
};

test('local cli: ./a commands named after a task are that task', () => {
  const stacks = detectStacks(mkRepo({ 'composer.json': ADMIN_COMPOSER, ...LOCAL_CLI }));
  const cli = get(stacks, 'localcli')!;
  assert.equal(cli.label, 'Local CLI (./a)');
  assert.equal(first(cli, 'dev'), './a dev');
  assert.equal(first(cli, 'test'), undefined);
  assert.equal(detectStacks(mkRepo({ 'cli/commands/x.sh': '' })).length, 0);
});

test('local cli: commands, descriptions and -y support are read from the scripts', () => {
  const cli = detectLocalCli(mkRepo(LOCAL_CLI))!;
  assert.equal(cli.entry, './a');
  assert.deepEqual(cli.commands.map((c) => c.name), ['deploy:staging', 'dev', 'ssh']);
  assert.equal(cli.commands[1]!.desc, 'docker dev environment');
  assert.deepEqual(cli.commands.map((c) => c.acceptsYes), [true, false, false]);
  assert.equal(detectLocalCli(mkRepo({ 'cli/run': '' }))?.entry, undefined);
  assert.equal(detectLocalCli(mkRepo({ 'cli/run': '', 'cli/commands/a.sh': '' }))?.entry, './cli/run');
});
