import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContext } from '@pulpfixer/kit/context';
import { detectDeploy } from '@pulpfixer/kit/detect/deploy';
import { applyMessage, parseDeployArgs } from '../src/commands/deploy.js';
import { deploySetupPrompt } from '../src/commands/repo.js';
import { json, lines, mkRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

function pf(cwd: string, ...args: string[]) {
  const env = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_NO_TRAVOLTA: '1', PF_HOME: mkRepo({}) };
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, err: r.stderr, out: r.stdout };
}

const git = { '.git/HEAD': '' };
const cfg = (commands: Record<string, unknown>) => json({ commands });

test('detectDeploy: pulpfixer.json, a package script, a composer script or ./a deploy; never platform configs', () => {
  assert.deepEqual(lines(detectDeploy(buildContext(mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: './tl d' } }) }))).steps), ['./tl d']);
  assert.deepEqual(lines(detectDeploy(buildContext(mkRepo({ ...git, 'package.json': json({ scripts: { deploy: 'x' } }) }))).steps), ['npm run deploy']);
  assert.deepEqual(lines(detectDeploy(buildContext(mkRepo({ ...git, 'composer.json': json({ scripts: { deploy: 'x' } }) }))).steps), ['composer run deploy']);
  const cli = { a: '', 'cli/run': '', 'cli/commands/deploy.sh': '# usage: ./a deploy [message]\n' };
  const local = detectDeploy(buildContext(mkRepo({ ...git, ...cli }))).steps[0]!;
  assert.deepEqual(local.cmd.argv, ['./a', 'deploy']);
  assert.equal(local.acceptsMessage, true);
  assert.deepEqual(detectDeploy(buildContext(mkRepo({ ...git, 'vercel.json': '{}', 'netlify.toml': '' }))).steps, []);
});

test('pulpfixer.json "message": true marks a command that takes a commit message, other values are dropped', () => {
  const ctx = buildContext(mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: './al d', message: true }, 'deploy:staging': { run: 'x', message: 'yes' } }) }));
  assert.equal(ctx.config.commands.deploy!.message, true);
  assert.equal(ctx.config.commands['deploy:staging']!.message, undefined);
  assert.equal(detectDeploy(ctx).steps[0]!.acceptsMessage, true);
});

test('parseDeployArgs: environment word, message words, -m and mistyped flags', () => {
  assert.deepEqual(parseDeployArgs([]), { options: { dryRun: false, yes: false } });
  assert.deepEqual(parseDeployArgs(['staging', 'fix', 'login']), { env: 'staging', options: { dryRun: false, yes: false, message: 'fix login' } });
  assert.deepEqual(parseDeployArgs(['fix', 'bug']), { options: { dryRun: false, yes: false, message: 'fix bug' } });
  assert.equal(parseDeployArgs(['production', '-m', 'release 3.4', '-n']).options.message, 'release 3.4');
  assert.equal(parseDeployArgs(['-m', 'explicit', 'words']).options.message, 'explicit');
  assert.equal(parseDeployArgs(['--dryrun']).bad, '--dryrun');
  assert.equal(parseDeployArgs(['--', '-fix']).options.message, '-fix');
  assert.equal(parseDeployArgs(['--dry-run', '--yes']).options.dryRun, true);
});

test('applyMessage quotes the message as one argument on the last step, only when it takes one', () => {
  const take = { cmd: { argv: ['./tl d'], shell: true }, source: 'pulpfixer.json', acceptsMessage: true };
  const plain = { cmd: { argv: ['make'], shell: true }, source: 'x' };
  assert.equal(applyMessage([take], "it's fixed").steps[0]!.cmd.argv[0], `./tl d 'it'\\''s fixed'`);
  assert.equal(applyMessage([take], 'fix').steps[0]!.cmd.argv[0], './tl d fix');
  const two = applyMessage([plain, take], 'fix login');
  assert.equal(two.steps[0]!.cmd.argv[0], 'make');
  assert.equal(two.steps[1]!.cmd.argv[0], `./tl d 'fix login'`);
  assert.deepEqual(applyMessage([plain], 'fix'), { steps: [plain], ignored: true });
  assert.deepEqual(applyMessage([take], undefined), { steps: [take], ignored: false });
});

test('pf deploy picks staging, then production, then the bare deploy', () => {
  const all = mkRepo({ ...git, 'pulpfixer.json': cfg({ 'deploy:staging': { run: 'echo stg' }, 'deploy:production': { run: 'echo prd' }, deploy: { run: 'echo bare' } }) });
  const a = pf(all, 'deploy', '--dry-run');
  assert.equal(a.code, 0, a.err);
  assert.match(a.err, /echo stg/);
  assert.doesNotMatch(a.err, /echo prd|echo bare/);
  assert.match(a.err, /staging is configured/);
  const prod = mkRepo({ ...git, 'pulpfixer.json': cfg({ 'deploy:production': { run: 'echo prd' }, deploy: { run: 'echo bare' } }) });
  const b = pf(prod, 'deploy', '--dry-run');
  assert.match(b.err, /PRODUCTION/);
  assert.match(b.err, /echo prd/);
  const bare = pf(mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: 'echo bare' } }) }), 'd', '--dry-run');
  assert.equal(bare.code, 0, bare.err);
  assert.match(bare.err, /echo bare/);
  assert.match(bare.err, /asks first/);
});

test('pf deploy with nothing configured fails with a hint', () => {
  const r = pf(mkRepo({ ...git, 'package.json': json({ scripts: {} }) }), 'deploy', '--dry-run');
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing to deploy/);
  assert.match(r.err, /pf rp --deploy/);
});

test('a bare deploy asks first: no terminal needs --yes', () => {
  const dir = mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: 'echo bare' } }) });
  const r = pf(dir, 'd');
  assert.equal(r.code, 2);
  assert.match(r.err, /refusing to deploy/);
  assert.equal(pf(dir, 'd', '--yes').code, 0);
});

test('pf d "message" reaches a command that takes one, quoted, and warns for one that does not', () => {
  const dir = mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: './tl d', message: true } }) });
  const a = pf(dir, 'd', '--dry-run', 'fix login');
  assert.match(a.err, /\.\/tl d 'fix login'/);
  assert.doesNotMatch(a.err, /takes no message/);
  assert.match(pf(dir, 'd', '-m', "it's fixed", '--dry-run').err, /\.\/tl d 'it'\\''s fixed'/);
  const none = mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: 'echo bare' } }) });
  const b = pf(none, 'd', '--dry-run', 'fix');
  assert.equal(b.code, 0);
  assert.match(b.err, /takes no message, ignored: fix/);
  assert.doesNotMatch(b.err, /echo bare fix/);
});

test('pf ds and pf dp take a message too; the environment word is not part of it', () => {
  const dir = mkRepo({ ...git, 'pulpfixer.json': cfg({ 'deploy:staging': { run: './al d', message: true }, 'deploy:production': { run: './al d', message: true } }) });
  assert.match(pf(dir, 'ds', '--dry-run', 'fix', 'login').err, /\.\/al d 'fix login'/);
  const dp = pf(dir, 'dp', '--dry-run', 'release');
  assert.match(dp.err, /PRODUCTION/);
  assert.match(dp.err, /\.\/al d release/);
  assert.match(pf(dir, 'deploy', 'staging', 'fix', '--dry-run').err, /\.\/al d fix/);
});

test('a mistyped flag is an error, not a commit message', () => {
  const dir = mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: 'echo bare', message: true } }) });
  const r = pf(dir, 'd', '--dryrun');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --dryrun/);
});

test('the menu list shows the bare deploy and does not run it as a custom command', () => {
  const dir = mkRepo({ ...git, 'pulpfixer.json': cfg({ deploy: { run: 'echo bare' } }) });
  const r = pf(dir, 'list');
  assert.equal(r.code, 0);
  assert.match(r.out, /pf deploy\s+Deploy \(the repo's own deploy command\)\s+echo bare, asks first/);
  assert.equal(r.out.match(/^\s+pf deploy\b/gm)?.length, 1);
  assert.doesNotMatch(r.out, /pf d(eploy)? .*echo bare\s*$/m);
});

test('the deploy-setup skill ships with pf, and the setup prompt names the ranked helpers', () => {
  const skill = fs.readFileSync(path.join(root, 'assets', 'skills', 'deploy-setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: deploy-setup\n/);
  const prompt = deploySetupPrompt([{ file: 'al', local: true, serverOnly: false, branch: true, score: 14, reasons: ['marked local (GWLOCAL)'] }]);
  assert.match(prompt, /pf_skill with name "deploy-setup"/);
  assert.match(prompt, /al \(marked local/);
  assert.match(prompt, /key "deploy"/);
  assert.match(deploySetupPrompt([], 'deploy:staging'), /key "deploy:staging"/);
  assert.match(deploySetupPrompt([]), /no helper script/);
});
