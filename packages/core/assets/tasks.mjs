#!/usr/bin/env node
/**
 * @skill pnpm
 *
 * Zero-dependency helper that gives a pnpm repo a few predefined root commands:
 *
 *   pnpm ask              list the root scripts, grouped and described
 *   pnpm doc              run the docs site locally (where one exists)
 *   pnpm deploy:staging   deploy to staging (where a staging target exists)
 *
 * The `pnpm` skill copies this file into the repo (scripts/tasks.mjs) and wires
 * the package.json scripts. Detection runs again on every call, so the commands
 * keep working when the docs site or the deploy setup moves.
 *
 *   node scripts/tasks.mjs ask
 *   node scripts/tasks.mjs doc [args passed to the docs command]
 *   node scripts/tasks.mjs deploy-staging [--dry-run]
 *   node scripts/tasks.mjs setup [--root <dir>] [--dry-run]
 *
 * Needs Node >= 18. Colors follow NO_COLOR / FORCE_COLOR.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const MARKER = '@skill pnpm'

// ---------------------------------------------------------------- output

const color =
  process.env.NO_COLOR ? false : process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb'
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const c = { bold: paint('1'), dim: paint('2'), cyan: paint('36'), yellow: paint('33'), green: paint('32'), red: paint('31'), heading: paint('1;35') }

const fail = (message) => {
  console.error(c.red('error: ') + message)
  process.exit(1)
}

// ---------------------------------------------------------------- fs helpers

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const subdirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
  } catch {
    return []
  }
}
const posix = (p) => p.split(sep).join('/')

// ---------------------------------------------------------------- workspace

function workspaceGlobs(root) {
  const globs = []
  let inPackages = false
  for (const line of read(join(root, 'pnpm-workspace.yaml')).split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const item = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/)
    if (item) globs.push(item[1])
    else if (/^[^\s#]/.test(line)) inPackages = false
  }
  const ws = readJson(join(root, 'package.json'))?.workspaces
  globs.push(...(Array.isArray(ws) ? ws : (ws?.packages ?? [])))
  return globs
}

const globToRegExp = (g) =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$')

/** Root plus every workspace package: [{ rel, dir, pkg }]. `rel` is '.' for the root. */
function packages(root) {
  const include = []
  const exclude = []
  for (const raw of workspaceGlobs(root)) {
    const g = raw.replace(/^!/, '').replace(/^\.\//, '').replace(/\/$/, '')
    ;(raw.startsWith('!') ? exclude : include).push(g)
  }
  const found = new Set()
  const walk = (base, depth) => {
    for (const name of subdirs(join(root, base))) {
      found.add(posix(join(base, name)))
      if (depth > 1) walk(join(base, name), depth - 1)
    }
  }
  for (const g of include) {
    if (g.endsWith('/**')) walk(g.slice(0, -3), 3)
    else if (g.endsWith('/*')) for (const name of subdirs(join(root, g.slice(0, -2)))) found.add(`${g.slice(0, -2)}/${name}`)
    else found.add(g)
  }
  const excluded = exclude.map(globToRegExp)
  const out = []
  const rootPkg = readJson(join(root, 'package.json'))
  if (rootPkg) out.push({ rel: '.', dir: root, pkg: rootPkg })
  for (const rel of [...found].sort()) {
    if (excluded.some((re) => re.test(rel))) continue
    const pkg = readJson(join(root, rel, 'package.json'))
    if (pkg) out.push({ rel, dir: join(root, rel), pkg })
  }
  return out
}

const depsOf = (pkg) => Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies })
/** First of `names` that is a script of `pkg`, ignoring scripts this tool installed (avoids recursion). */
const findScript = (pkg, ...names) =>
  names.find((n) => typeof pkg?.scripts?.[n] === 'string' && !/tasks\.mjs/.test(pkg.scripts[n]))

/** `pnpm exec <bin>` when installed locally, otherwise `pnpm dlx <package>`. */
const tool = (root, dir, bin, pkg = bin) =>
  [dir, root].some((d) => existsSync(join(d, 'node_modules', '.bin', bin))) ? `pnpm exec ${bin}` : `pnpm dlx ${pkg}`

// ---------------------------------------------------------------- detect: docs

const DOC_FRAMEWORKS = ['nextra', 'nextra-theme-docs', '@docusaurus/core', 'vitepress', '@astrojs/starlight', 'fumadocs-core', 'fumadocs-ui', 'vocs']

/** @returns {{ steps: Step[], notes: string[] }} */
function detectDocs(root) {
  const none = (...notes) => ({ steps: [], notes })
  const rootScript = findScript(readJson(join(root, 'package.json')), 'docs:dev', 'docs:start', 'doc:dev', 'docs')
  if (rootScript) return { steps: [{ cwd: root, command: `pnpm run ${rootScript}`, label: `root script "${rootScript}"` }], notes: [] }

  const pkgs = packages(root)
  const isDocs = (p) =>
    p.rel !== '.' &&
    (/^(docs?|documentation)$/.test(basename(p.rel)) ||
      /\/(docs?|documentation)$/.test(p.pkg.name ?? '') ||
      depsOf(p.pkg).some((d) => DOC_FRAMEWORKS.includes(d)))
  for (const p of pkgs.filter(isDocs)) {
    const script = findScript(p.pkg, 'dev', 'start', 'docs:dev')
    if (script) return { steps: [{ cwd: root, command: `pnpm --dir ${p.rel} run ${script}`, label: p.rel }], notes: [] }
  }
  const rootPkg = pkgs.find((p) => p.rel === '.')
  if (rootPkg && depsOf(rootPkg.pkg).some((d) => DOC_FRAMEWORKS.includes(d))) {
    const script = findScript(rootPkg.pkg, 'dev', 'start')
    if (script) return { steps: [{ cwd: root, command: `pnpm run ${script}`, label: 'root docs site' }], notes: [] }
  }
  for (const dir of ['.', 'docs']) {
    if (isDir(join(root, dir, '.vitepress'))) {
      return { steps: [{ cwd: root, command: `${tool(root, root, 'vitepress')} dev ${dir}`, label: `VitePress in ${dir}` }], notes: [] }
    }
  }
  for (const file of ['mkdocs.yml', 'mkdocs.yaml']) {
    if (existsSync(join(root, file))) return { steps: [{ cwd: root, command: 'mkdocs serve', label: 'MkDocs' }], notes: [] }
  }
  return none('no docs site found (looked for a docs workspace package, docs framework, VitePress, MkDocs, or a root docs script)')
}

// ---------------------------------------------------------------- detect: staging deploy

const STAGING_SCRIPTS = ['deploy:staging', 'deploy-staging', 'staging:deploy', 'deploy:stage', 'stage:deploy']

function detectDeploy(root) {
  const pkgs = packages(root)

  // 1. An explicit staging script in the root or a workspace package wins.
  const scripted = pkgs.flatMap((p) => {
    const name = findScript(p.pkg, ...STAGING_SCRIPTS)
    if (!name) return []
    const command = p.rel === '.' ? `pnpm run ${name}` : `pnpm --dir ${p.rel} run ${name}`
    return [{ cwd: root, command, label: p.rel === '.' ? `root script "${name}"` : `${p.rel} script "${name}"` }]
  })
  const rootFirst = scripted.some((s) => s.label.startsWith('root'))
  if (scripted.length > 0) return { steps: rootFirst ? scripted.filter((s) => s.label.startsWith('root')) : scripted, notes: [] }

  // 2. A staging workflow that can be started by hand.
  const wfDir = join(root, '.github', 'workflows')
  let workflows = []
  try {
    workflows = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f) && /stag/i.test(f))
  } catch {
    /* no workflows */
  }
  for (const file of workflows) {
    if (/workflow_dispatch/.test(read(join(wfDir, file)))) {
      return { steps: [{ cwd: root, command: `gh workflow run ${file}`, label: `GitHub workflow ${file}` }], notes: [] }
    }
  }

  // 3. Platform configs in the root and in every workspace package.
  const steps = []
  const notes = []
  for (const { rel, dir, pkg } of pkgs) {
    const where = rel === '.' ? '' : ` in ${rel}`
    const has = (...files) => files.find((f) => existsSync(join(dir, f)))
    const build = pkg?.scripts?.build ? 'pnpm run build && ' : ''
    const add = (label, command) => steps.push({ cwd: dir, command, label: label + where })

    if (has('firebase.json')) {
      if (readJson(join(dir, '.firebaserc'))?.projects?.staging) {
        add('Firebase', `${build}${tool(root, dir, 'firebase', 'firebase-tools')} deploy --project staging`)
      } else notes.push(`Firebase${where}: .firebaserc has no "staging" project alias (firebase use --add)`)
    }
    const wrangler = has('wrangler.toml', 'wrangler.json', 'wrangler.jsonc')
    if (wrangler) {
      if (/\[env\.staging\]|"staging"\s*:/.test(read(join(dir, wrangler)))) {
        add('Cloudflare', `${tool(root, dir, 'wrangler')} deploy --env staging`)
      } else notes.push(`Cloudflare${where}: ${wrangler} has no staging environment`)
    }
    if (has('fly.staging.toml')) add('Fly.io', 'fly deploy --config fly.staging.toml')
    else if (has('fly.toml')) notes.push(`Fly.io${where}: no fly.staging.toml`)
    if (has('serverless.yml', 'serverless.yaml', 'serverless.ts', 'serverless.js', 'serverless.mjs')) {
      add('Serverless', `${tool(root, dir, 'serverless')} deploy --stage staging`)
    }
    if (has('sst.config.ts')) add('SST', `${tool(root, dir, 'sst')} deploy --stage staging`)
    if (has('netlify.toml')) add('Netlify draft', `${tool(root, dir, 'netlify', 'netlify-cli')} deploy --build`)
    if (has('vercel.json', join('.vercel', 'project.json')) || depsOf(pkg).includes('vercel')) {
      add('Vercel preview', `${tool(root, dir, 'vercel')} deploy`)
    }
  }
  if (steps.length > 0) return { steps, notes: [] }
  return { steps: [], notes: notes.length ? notes : ['no staging deployment found (looked for a deploy:staging script, a staging workflow, Vercel, Netlify, Firebase, Cloudflare, Fly.io, Serverless, SST)'] }
}

// ---------------------------------------------------------------- commands: ask / doc / deploy-staging

function ask(root) {
  const pkg = readJson(join(root, 'package.json')) ?? fail(`no package.json in ${root}`)
  const scripts = pkg.scripts ?? {}
  const info = pkg.scriptsInfo ?? {}
  const groups = Object.entries(info).map(([title, entries]) => [title, Object.entries(entries).filter(([name]) => name in scripts)])
  const described = new Set(groups.flatMap(([, entries]) => entries.map(([name]) => name)))
  const undescribed = Object.keys(scripts).filter((name) => !described.has(name))
  if (undescribed.length > 0) groups.push(['Other', undescribed.map((name) => [name, c.dim('(no description in scriptsInfo)')])])

  const width = Math.max(0, ...Object.keys(scripts).map((name) => name.length))
  console.info(c.bold(`${pkg.name ?? basename(root)} commands`) + c.dim('  (pnpm <command>)'))
  for (const [title, entries] of groups) {
    if (entries.length === 0) continue
    console.info('')
    console.info(c.heading(title))
    for (const [name, description] of entries) console.info(`  ${c.cyan(name.padEnd(width))}  ${description}`)
  }
  console.info('')
  console.info(c.dim('Package scripts: ') + c.yellow('pnpm --filter <package> run <script>'))
}

function runSteps(root, { steps, notes }, what, { dryRun = false, extraArgs = [] } = {}) {
  if (steps.length === 0) fail(`${what} is not available here: ${notes.join('; ')}`)
  for (const step of steps) {
    const command = [step.command, ...extraArgs].join(' ')
    const where = step.cwd === root ? '' : ` (in ${relative(root, step.cwd)})`
    console.info(c.dim('→ ') + c.bold(command) + c.dim(`${where}  [${step.label}]`))
    if (dryRun) continue
    const result = spawnSync(command, { cwd: step.cwd, stdio: 'inherit', shell: true })
    if (result.error) fail(result.error.message)
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

// ---------------------------------------------------------------- setup

const WIRING = [
  { name: 'ask', group: 'Help', run: 'ask', detect: null, describe: () => 'Show this list' },
  { name: 'doc', group: 'Develop', run: 'doc', detect: detectDocs, describe: (d) => `Run the docs site locally (${d.steps[0].label})` },
  {
    name: 'deploy:staging',
    group: 'Deploy',
    run: 'deploy-staging',
    detect: detectDeploy,
    describe: (d) => `Deploy to staging (${d.steps.map((s) => s.label).join(', ')}); add --dry-run to preview`,
  },
]

function setup(root, dryRun) {
  const pkgPath = join(root, 'package.json')
  const raw = read(pkgPath)
  if (!raw) fail(`no package.json in ${root}. Run from the repo root or pass --root <dir>.`)
  const pkg = JSON.parse(raw)
  pkg.scripts ??= {}
  const notes = []
  if (!/^pnpm@/.test(pkg.packageManager ?? '') && !existsSync(join(root, 'pnpm-lock.yaml')) && !existsSync(join(root, 'pnpm-workspace.yaml'))) {
    notes.push('this does not look like a pnpm repo (no packageManager, pnpm-lock.yaml or pnpm-workspace.yaml); wiring it anyway')
  }

  // Where the helper lives: reuse the path of an earlier install, else scripts/tasks.mjs.
  const ours = (file) => file === SELF || read(file).includes(MARKER)
  const prior = Object.values(pkg.scripts)
    .map((v) => String(v).match(/node\s+(\S*tasks\.mjs)/)?.[1])
    .find((p) => p && existsSync(join(root, p)) && ours(join(root, p)))
  const helperRel = prior ?? ['scripts/tasks.mjs', 'scripts/pnpm-tasks.mjs'].find((p) => !existsSync(join(root, p)) || ours(join(root, p)))
  if (!helperRel) fail('scripts/tasks.mjs and scripts/pnpm-tasks.mjs exist and are not this helper; remove one and rerun')
  const helperPath = resolve(root, helperRel)

  const rows = []
  for (const w of WIRING) {
    const value = `node ${helperRel} ${w.run}`
    const current = pkg.scripts[w.name]
    if (current !== undefined && !/tasks\.mjs/.test(current)) {
      rows.push([w.name, 'kept', `existing script: ${current}`])
      continue
    }
    const found = w.detect ? w.detect(root) : null
    if (w.detect && found.steps.length === 0) {
      if (current !== undefined) delete pkg.scripts[w.name]
      rows.push([w.name, 'skipped', found.notes.join('; ')])
      continue
    }
    pkg.scripts[w.name] = value
    describeScript(pkg, w.group, w.name, w.describe(found))
    rows.push([w.name, current === undefined ? 'added' : current === value ? 'unchanged' : 'updated', found ? found.steps.map((s) => s.command).join(' ; ') : value])
  }

  const described = new Set(Object.values(pkg.scriptsInfo ?? {}).flatMap((g) => Object.keys(g)))
  const undescribed = Object.keys(pkg.scripts).filter((n) => !described.has(n))

  if (!dryRun) {
    if (helperPath !== SELF) {
      mkdirSync(dirname(helperPath), { recursive: true })
      copyFileSync(SELF, helperPath)
    }
    const indent = raw.match(/^([ \t]+)"/m)?.[1] ?? '  '
    writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + (raw.endsWith('\n') ? '\n' : ''))
  }

  const width = Math.max(...rows.map((r) => r[0].length))
  console.info(c.bold(`pnpm skill: ${dryRun ? 'preview for' : 'set up'} ${root}`))
  for (const [name, status, detail] of rows) {
    const tint = status === 'skipped' || status === 'kept' ? c.yellow : c.green
    console.info(`  ${c.cyan(name.padEnd(width))}  ${tint(status.padEnd(9))} ${detail}`)
  }
  console.info(c.dim(`  helper: ${helperRel}${helperPath === SELF || dryRun ? '' : ' (copied)'}`))
  for (const n of notes) console.info(c.yellow('  note: ') + n)
  if (undescribed.length > 0) console.info(c.yellow('  needs a scriptsInfo description: ') + undescribed.join(', '))
}

function describeScript(pkg, group, name, description) {
  pkg.scriptsInfo ??= {}
  const existing = Object.keys(pkg.scriptsInfo).find((g) => name in pkg.scriptsInfo[g])
  const key = existing ?? Object.keys(pkg.scriptsInfo).find((g) => g.toLowerCase() === group.toLowerCase()) ?? group
  pkg.scriptsInfo[key] ??= {}
  pkg.scriptsInfo[key][name] = description
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2)
const command = args.shift()
const flag = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}
const option = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

const skillDir = resolve(dirname(SELF), '..')
const defaultRoot = !existsSync(join(skillDir, 'SKILL.md')) && existsSync(join(skillDir, 'package.json')) ? skillDir : process.cwd()
const root = resolve(option('--root') ?? defaultRoot)
const dryRun = flag('--dry-run')

switch (command) {
  case 'ask':
    ask(root)
    break
  case 'doc':
    runSteps(root, detectDocs(root), 'the docs site', { dryRun, extraArgs: args })
    break
  case 'deploy-staging':
    runSteps(root, detectDeploy(root), 'staging deployment', { dryRun })
    break
  case 'setup':
    setup(root, dryRun)
    break
  default:
    console.info('Usage: tasks.mjs <ask | doc [args] | deploy-staging [--dry-run] | setup [--root <dir>] [--dry-run]>')
    process.exit(command ? 1 : 0)
}
