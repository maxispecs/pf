import path from 'node:path';
import type { Cmd } from '../exec.js';
import { exists, listDir, readJson, readText } from '../util.js';

export type Task = 'dev' | 'build' | 'test' | 'lint' | 'install';
export const TASKS: Task[] = ['dev', 'build', 'test', 'lint', 'install'];

export interface Candidate {
  cmd: Cmd;
  /** Where the command came from, e.g. "package.json script dev". */
  source: string;
}

export interface StackInfo {
  id: string;
  label: string;
  manager?: string;
  /** Commands from scripts or targets the repo already defines. */
  scripts: Partial<Record<Task, Candidate[]>>;
  /** Conventional commands for the stack. */
  defaults: Partial<Record<Task, Candidate[]>>;
}

const argv = (root: string, ...a: string[]): Cmd => ({ argv: a, cwd: root });

function make(id: string, label: string, manager?: string): StackInfo {
  return { id, label, ...(manager ? { manager } : {}), scripts: {}, defaults: {} };
}

function add(map: Partial<Record<Task, Candidate[]>>, task: Task, cmd: Cmd, source: string): void {
  (map[task] ??= []).push({ cmd, source });
}

// ---------- Node

const NODE_PMS = ['pnpm', 'npm', 'yarn', 'bun'];

export function nodeManager(root: string): string {
  const pkg = readJson<{ packageManager?: string }>(root, 'package.json');
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared && NODE_PMS.includes(declared)) return declared;
  if (exists(root, 'pnpm-lock.yaml') || exists(root, 'pnpm-workspace.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'bun.lock') || exists(root, 'bun.lockb')) return 'bun';
  return 'npm';
}

/** `<pm> run <script>`. */
export function nodeRun(pm: string, script: string): string[] {
  return [pm, 'run', script];
}

const NODE_SCRIPTS: Record<Task, string[]> = {
  dev: ['dev', 'start:dev', 'serve', 'start'],
  build: ['build'],
  test: ['test'],
  lint: ['lint'],
  install: [],
};

function detectNode(root: string): StackInfo | null {
  const pkg = readJson<{ scripts?: Record<string, string> }>(root, 'package.json');
  if (!pkg) return null;
  const pm = nodeManager(root);
  const s = make('node', `Node (${pm})`, pm);
  const scripts = pkg.scripts ?? {};
  for (const task of TASKS) {
    for (const name of NODE_SCRIPTS[task]) {
      const body = scripts[name];
      if (typeof body !== 'string') continue;
      if (task === 'test' && /no test specified/.test(body)) continue;
      add(s.scripts, task, argv(root, ...nodeRun(pm, name)), `package.json script ${name}`);
    }
  }
  add(s.defaults, 'install', argv(root, pm, 'install'), `${pm} default`);
  return s;
}

// ---------- Python

function detectPython(root: string): StackInfo | null {
  const toml = readText(root, 'pyproject.toml');
  const hasReq = exists(root, 'requirements.txt');
  if (toml === null && !hasReq && !exists(root, 'setup.py') && !exists(root, 'Pipfile')) return null;
  const t = toml ?? '';
  let pm = 'pip';
  if (exists(root, 'uv.lock') || /\[tool\.uv\]/.test(t)) pm = 'uv';
  else if (exists(root, 'poetry.lock') || /\[tool\.poetry\]/.test(t)) pm = 'poetry';
  else if (exists(root, 'Pipfile')) pm = 'pipenv';
  const s = make('python', `Python (${pm})`, pm);
  const prefix: string[] = pm === 'uv' ? ['uv', 'run'] : pm === 'poetry' ? ['poetry', 'run'] : pm === 'pipenv' ? ['pipenv', 'run'] : [];
  const py = (...a: string[]) => (prefix.length ? [...prefix, 'python', ...a] : ['python3', ...a]);
  const tool = (name: string, ...a: string[]) => (prefix.length ? [...prefix, name, ...a] : ['python3', '-m', name, ...a]);
  const src = `${pm} default`;

  if (exists(root, 'manage.py')) add(s.defaults, 'dev', argv(root, ...py('manage.py', 'runserver')), `${src} (Django)`);
  else if (/fastapi/i.test(t) || /fastapi/i.test(readText(root, 'requirements.txt') ?? '')) {
    add(s.defaults, 'dev', argv(root, ...(prefix.length ? [...prefix, 'fastapi', 'dev'] : ['fastapi', 'dev'])), `${src} (FastAPI)`);
  } else if (/flask/i.test(t) || /flask/i.test(readText(root, 'requirements.txt') ?? '')) {
    add(s.defaults, 'dev', argv(root, ...(prefix.length ? [...prefix, 'flask', 'run', '--debug'] : ['flask', 'run', '--debug'])), `${src} (Flask)`);
  }

  if (/\[build-system\]/.test(t)) {
    add(s.defaults, 'build', argv(root, ...(pm === 'uv' ? ['uv', 'build'] : pm === 'poetry' ? ['poetry', 'build'] : ['python3', '-m', 'build'])), src);
  }
  if (/pytest/i.test(t) || exists(root, 'pytest.ini') || exists(root, 'conftest.py') || exists(root, 'tests')) {
    add(s.defaults, 'test', argv(root, ...(prefix.length ? [...prefix, 'pytest'] : tool('pytest'))), src);
  }
  if (/\[tool\.ruff/.test(t) || exists(root, 'ruff.toml') || exists(root, '.ruff.toml')) {
    add(s.defaults, 'lint', argv(root, ...(prefix.length ? [...prefix, 'ruff', 'check', '.'] : ['ruff', 'check', '.'])), src);
  }
  const install =
    pm === 'uv' ? ['uv', 'sync']
    : pm === 'poetry' ? ['poetry', 'install']
    : pm === 'pipenv' ? ['pipenv', 'install']
    : hasReq ? ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt']
    : ['python3', '-m', 'pip', 'install', '-e', '.'];
  add(s.defaults, 'install', argv(root, ...install), src);
  return s;
}

// ---------- Go, Rust, Swift

function detectGo(root: string): StackInfo | null {
  if (!exists(root, 'go.mod')) return null;
  const s = make('go', 'Go');
  add(s.defaults, 'dev', argv(root, 'go', 'run', '.'), 'go default');
  add(s.defaults, 'build', argv(root, 'go', 'build', './...'), 'go default');
  add(s.defaults, 'test', argv(root, 'go', 'test', './...'), 'go default');
  const golangci = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'].some((f) => exists(root, f));
  add(s.defaults, 'lint', golangci ? argv(root, 'golangci-lint', 'run') : argv(root, 'go', 'vet', './...'), 'go default');
  add(s.defaults, 'install', argv(root, 'go', 'mod', 'download'), 'go default');
  return s;
}

function detectRust(root: string): StackInfo | null {
  if (!exists(root, 'Cargo.toml')) return null;
  const s = make('rust', 'Rust');
  add(s.defaults, 'dev', argv(root, 'cargo', 'run'), 'cargo default');
  add(s.defaults, 'build', argv(root, 'cargo', 'build'), 'cargo default');
  add(s.defaults, 'test', argv(root, 'cargo', 'test'), 'cargo default');
  add(s.defaults, 'lint', argv(root, 'cargo', 'clippy'), 'cargo default');
  add(s.defaults, 'install', argv(root, 'cargo', 'fetch'), 'cargo default');
  return s;
}

function detectSwift(root: string): StackInfo | null {
  if (!exists(root, 'Package.swift')) return null;
  const s = make('swift', 'Swift');
  add(s.defaults, 'dev', argv(root, 'swift', 'run'), 'swift default');
  add(s.defaults, 'build', argv(root, 'swift', 'build'), 'swift default');
  add(s.defaults, 'test', argv(root, 'swift', 'test'), 'swift default');
  add(s.defaults, 'install', argv(root, 'swift', 'package', 'resolve'), 'swift default');
  return s;
}

// ---------- Java

function detectMaven(root: string): StackInfo | null {
  const pom = readText(root, 'pom.xml');
  if (pom === null) return null;
  const mvn = exists(root, 'mvnw') ? './mvnw' : 'mvn';
  const s = make('maven', 'Java (Maven)', mvn === './mvnw' ? 'mvnw' : 'mvn');
  if (/spring-boot/.test(pom)) add(s.defaults, 'dev', argv(root, mvn, 'spring-boot:run'), 'maven default (Spring Boot)');
  else if (/quarkus/.test(pom)) add(s.defaults, 'dev', argv(root, mvn, 'quarkus:dev'), 'maven default (Quarkus)');
  add(s.defaults, 'build', argv(root, mvn, 'package'), 'maven default');
  add(s.defaults, 'test', argv(root, mvn, 'test'), 'maven default');
  add(s.defaults, 'install', argv(root, mvn, 'dependency:resolve'), 'maven default');
  return s;
}

function detectGradle(root: string): StackInfo | null {
  const file = ['build.gradle.kts', 'build.gradle'].find((f) => exists(root, f));
  if (!file) return null;
  const text = readText(root, file) ?? '';
  const gw = exists(root, 'gradlew') ? './gradlew' : 'gradle';
  const s = make('gradle', 'Java (Gradle)', gw === './gradlew' ? 'gradlew' : 'gradle');
  if (/org\.springframework\.boot/.test(text)) add(s.defaults, 'dev', argv(root, gw, 'bootRun'), 'gradle default (Spring Boot)');
  else if (/quarkus/.test(text)) add(s.defaults, 'dev', argv(root, gw, 'quarkusDev'), 'gradle default (Quarkus)');
  else if (/\bapplication\b/.test(text)) add(s.defaults, 'dev', argv(root, gw, 'run'), 'gradle default');
  add(s.defaults, 'build', argv(root, gw, 'build'), 'gradle default');
  add(s.defaults, 'test', argv(root, gw, 'test'), 'gradle default');
  if (/spotless/.test(text)) add(s.defaults, 'lint', argv(root, gw, 'spotlessCheck'), 'gradle default (Spotless)');
  else if (/checkstyle/.test(text)) add(s.defaults, 'lint', argv(root, gw, 'checkstyleMain'), 'gradle default (Checkstyle)');
  return s;
}

// ---------- .NET, Ruby, PHP, Elixir

function detectDotnet(root: string): StackInfo | null {
  const files = listDir(root);
  const project = files.some((f) => /\.(csproj|fsproj)$/.test(f));
  if (!project && !files.some((f) => /\.(sln|slnx)$/.test(f))) return null;
  const s = make('dotnet', '.NET');
  if (project) add(s.defaults, 'dev', argv(root, 'dotnet', 'watch', 'run'), 'dotnet default');
  add(s.defaults, 'build', argv(root, 'dotnet', 'build'), 'dotnet default');
  add(s.defaults, 'test', argv(root, 'dotnet', 'test'), 'dotnet default');
  add(s.defaults, 'lint', argv(root, 'dotnet', 'format', '--verify-no-changes'), 'dotnet default');
  add(s.defaults, 'install', argv(root, 'dotnet', 'restore'), 'dotnet default');
  return s;
}

function detectRuby(root: string): StackInfo | null {
  if (!exists(root, 'Gemfile')) return null;
  const s = make('ruby', 'Ruby', 'bundler');
  if (exists(root, 'bin', 'rails')) add(s.defaults, 'dev', argv(root, 'bin/rails', 'server'), 'rails default');
  add(s.defaults, 'test', exists(root, 'spec') ? argv(root, 'bundle', 'exec', 'rspec') : argv(root, 'bundle', 'exec', 'rake', 'test'), 'bundler default');
  if (exists(root, '.rubocop.yml')) add(s.defaults, 'lint', argv(root, 'bundle', 'exec', 'rubocop'), 'bundler default');
  add(s.defaults, 'install', argv(root, 'bundle', 'install'), 'bundler default');
  return s;
}

function detectPhp(root: string): StackInfo | null {
  const composer = readJson<{ scripts?: Record<string, unknown> }>(root, 'composer.json');
  if (!composer) return null;
  const s = make('php', 'PHP', 'composer');
  const scripts = composer.scripts ?? {};
  for (const [task, names] of [['dev', ['dev', 'serve', 'start']], ['test', ['test']], ['lint', ['lint', 'cs', 'cs-check']], ['build', ['build']]] as [Task, string[]][]) {
    for (const n of names) if (n in scripts) add(s.scripts, task, argv(root, 'composer', 'run', n), `composer script ${n}`);
  }
  if (exists(root, 'artisan')) {
    add(s.defaults, 'dev', argv(root, 'php', 'artisan', 'serve'), 'laravel default');
    add(s.defaults, 'test', argv(root, 'php', 'artisan', 'test'), 'laravel default');
  } else if (exists(root, 'vendor', 'bin', 'phpunit')) {
    add(s.defaults, 'test', argv(root, 'vendor/bin/phpunit'), 'composer default');
  }
  add(s.defaults, 'install', argv(root, 'composer', 'install'), 'composer default');
  return s;
}

function detectElixir(root: string): StackInfo | null {
  const mix = readText(root, 'mix.exs');
  if (mix === null) return null;
  const s = make('elixir', 'Elixir', 'mix');
  add(s.defaults, 'dev', /:phoenix\b/.test(mix) ? argv(root, 'mix', 'phx.server') : argv(root, 'iex', '-S', 'mix'), 'mix default');
  add(s.defaults, 'build', argv(root, 'mix', 'compile'), 'mix default');
  add(s.defaults, 'test', argv(root, 'mix', 'test'), 'mix default');
  add(s.defaults, 'lint', argv(root, 'mix', 'format', '--check-formatted'), 'mix default');
  add(s.defaults, 'install', argv(root, 'mix', 'deps.get'), 'mix default');
  return s;
}

// ---------- Makefile, justfile, Docker Compose

const TASK_TARGETS: Record<Task, string[]> = {
  dev: ['dev', 'run', 'serve', 'start', 'watch'],
  build: ['build'],
  test: ['test'],
  lint: ['lint'],
  install: ['install', 'setup', 'deps', 'bootstrap'],
};

export function makeTargets(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=:])/.exec(line);
    if (m && !m[1]!.startsWith('.')) out.add(m[1]!);
  }
  return [...out];
}

export function justRecipes(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:\n]*)?:(?!=)/.exec(line);
    if (m && !['set', 'alias', 'export', 'import', 'mod'].includes(m[1]!)) out.add(m[1]!);
  }
  return [...out];
}

function fromTargets(id: string, label: string, bin: string, names: string[], root: string): StackInfo | null {
  const s = make(id, label, bin);
  for (const task of TASKS) {
    for (const t of TASK_TARGETS[task]) {
      if (names.includes(t)) add(s.scripts, task, argv(root, bin, t), `${label} ${id === 'make' ? 'target' : 'recipe'} ${t}`);
    }
  }
  return s;
}

function detectMake(root: string): StackInfo | null {
  const file = ['Makefile', 'makefile', 'GNUmakefile'].find((f) => exists(root, f));
  if (!file) return null;
  return fromTargets('make', 'Make', 'make', makeTargets(readText(root, file) ?? ''), root);
}

function detectJust(root: string): StackInfo | null {
  const file = ['justfile', 'Justfile', '.justfile'].find((f) => exists(root, f));
  if (!file) return null;
  return fromTargets('just', 'Just', 'just', justRecipes(readText(root, file) ?? ''), root);
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

function detectCompose(root: string): StackInfo | null {
  if (!COMPOSE_FILES.some((f) => exists(root, f))) return null;
  const s = make('compose', 'Docker Compose', 'docker');
  add(s.defaults, 'dev', argv(root, 'docker', 'compose', 'up'), 'compose default');
  add(s.defaults, 'build', argv(root, 'docker', 'compose', 'build'), 'compose default');
  return s;
}

/** Detection order is also the priority order for resolving commands. */
const DETECTORS = [
  detectNode, detectPython, detectGo, detectRust, detectMaven, detectGradle, detectDotnet,
  detectRuby, detectPhp, detectElixir, detectSwift, detectMake, detectJust, detectCompose,
];

export function detectStacks(dir: string): StackInfo[] {
  const root = path.resolve(dir);
  const found: StackInfo[] = [];
  for (const d of DETECTORS) {
    const s = d(root);
    if (s) found.push(s);
  }
  return found;
}
