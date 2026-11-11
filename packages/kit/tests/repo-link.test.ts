import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadRepoConfig } from '../src/config.js';
import {
  linkRepo,
  listRepoRecords,
  newRepoId,
  normalizeRemote,
  readRepoRecord,
  REPO_LINK_REVISION,
  repoLink,
  repoSettings,
  saveRepoSettings,
} from '../src/repo-link.js';
import { json, mkRepo } from './helpers.js';

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.PF_HOME;
  process.env.PF_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PF_HOME;
    else process.env.PF_HOME = prev;
  }
}

const REMOTE = 'github.com/acme/api';

/** Link `root` the way `pf rp` does and return the new state. */
function link(root: string, remote: string | undefined = REMOTE, fresh = false) {
  const l = repoLink(root, loadRepoConfig(root), { name: 'api', remote });
  const r = linkRepo(root, l, { name: 'api', remote, fresh });
  assert.ok(r.ok, r.changes.join('\n'));
  return repoLink(root, loadRepoConfig(root), { name: 'api', remote });
}

test('normalizeRemote drops scheme, credentials and .git, so ssh and https forms match', () => {
  assert.equal(normalizeRemote('git@github.com:Acme/api.git'), REMOTE);
  assert.equal(normalizeRemote('https://user:secret@github.com/acme/api.git\n'), REMOTE);
  assert.equal(normalizeRemote('ssh://git@github.com/acme/api'), REMOTE);
  assert.equal(normalizeRemote('/srv/git/api.git'), '/srv/git/api');
  assert.equal(normalizeRemote(''), undefined);
});

test('newRepoId is a slug of the name plus a random suffix', () => {
  assert.match(newRepoId('@acme/My API'), /^my-api-[0-9a-f]{8}$/);
  assert.notEqual(newRepoId('api'), newRepoId('api'));
  assert.match(newRepoId('!!!'), /^repo-[0-9a-f]{8}$/);
});

test('linking writes the id into pulpfixer.json and a record in the state folder, keeping other keys', () => {
  withHome(mkRepo({}), () => {
    const root = mkRepo({ 'pulpfixer.json': json({ profile: 'acme', commands: { seed: './seed.sh' } }) });
    assert.equal(repoLink(root, loadRepoConfig(root), { remote: REMOTE }).state, 'unlinked');
    const now = link(root);
    assert.equal(now.state, 'linked');
    const file = JSON.parse(fs.readFileSync(path.join(root, 'pulpfixer.json'), 'utf8'));
    assert.equal(Object.keys(file)[0], 'id');
    assert.equal(file.profile, 'acme');
    assert.deepEqual(file.commands, { seed: './seed.sh' });
    const rec = readRepoRecord(file.id)!;
    assert.deepEqual(rec.paths, [path.resolve(root)]);
    assert.equal(rec.remote, REMOTE);
    assert.equal(rec.revision, REPO_LINK_REVISION);
    assert.equal(listRepoRecords().length, 1);
  });
});

test('a moved checkout or a changed remote is stale, and relinking keeps the id and settings', () => {
  withHome(mkRepo({}), () => {
    const root = mkRepo({});
    const { id } = link(root);
    assert.ok(saveRepoSettings(id!, { secretRef: 'vault:acme' }));

    const moved = mkRepo({ 'pulpfixer.json': fs.readFileSync(path.join(root, 'pulpfixer.json'), 'utf8') });
    const stale = repoLink(moved, loadRepoConfig(moved), { name: 'api', remote: REMOTE });
    assert.equal(stale.state, 'stale');
    assert.match(stale.reasons.join(), /checkout moved/);
    assert.deepEqual(repoSettings(stale), { secretRef: 'vault:acme' });
    assert.equal(link(moved).id, id);
    assert.deepEqual(readRepoRecord(id!)!.paths, [path.resolve(moved), path.resolve(root)]);

    const renamed = repoLink(moved, loadRepoConfig(moved), { name: 'api', remote: 'github.com/acme/api-v2' });
    assert.equal(renamed.state, 'stale');
    assert.match(renamed.reasons.join(), /remote changed/);
    assert.equal(link(moved, 'github.com/acme/api-v2').state, 'linked');
    assert.deepEqual(readRepoRecord(id!)!.settings, { secretRef: 'vault:acme' });
  });
});

test('pulpfixer.json without its id finds the record by path, and an older link revision is stale', () => {
  withHome(mkRepo({}), () => {
    const root = mkRepo({});
    const { id } = link(root);
    fs.writeFileSync(path.join(root, 'pulpfixer.json'), json({ name: 'api' }));
    const lost = repoLink(root, loadRepoConfig(root), { name: 'api', remote: REMOTE });
    assert.equal(lost.state, 'stale');
    assert.equal(lost.id, id);
    assert.equal(link(root).id, id);

    const recFile = path.join(process.env.PF_HOME!, 'repos', `${id}.json`);
    fs.writeFileSync(recFile, json({ ...JSON.parse(fs.readFileSync(recFile, 'utf8')), revision: 0 }));
    assert.match(repoLink(root, loadRepoConfig(root), { name: 'api', remote: REMOTE }).reasons.join(), /older pf/);
  });
});

test('an id whose record knows neither the path nor the remote is foreign and gets no settings', () => {
  withHome(mkRepo({}), () => {
    const root = mkRepo({});
    const { id } = link(root);
    saveRepoSettings(id!, { secretRef: 'vault:acme' });
    const other = mkRepo({ 'pulpfixer.json': json({ id }) });
    const foreign = repoLink(other, loadRepoConfig(other), { name: 'api', remote: 'github.com/evil/clone' });
    assert.equal(foreign.state, 'foreign');
    assert.deepEqual(repoSettings(foreign), {});

    const fresh = link(other, 'github.com/evil/clone', true);
    assert.equal(fresh.state, 'linked');
    assert.notEqual(fresh.id, id);
    assert.deepEqual(readRepoRecord(fresh.id!)!.settings, {});
  });
});

test('an id that is not a safe file name is never used as a path', () => {
  withHome(mkRepo({}), () => {
    const root = mkRepo({ 'pulpfixer.json': json({ id: '../config' }) });
    const l = repoLink(root, loadRepoConfig(root), { name: 'api', remote: undefined });
    assert.equal(l.state, 'unlinked');
    assert.match(l.reasons.join(), /not valid/);
    assert.equal(readRepoRecord('../config'), null);
    const r = linkRepo(root, l, { name: 'api', remote: undefined });
    assert.match(r.id, /^api-[0-9a-f]{8}$/);
  });
});

test('dry run writes neither pulpfixer.json nor a record', () => {
  withHome(mkRepo({}), () => {
    const root = mkRepo({});
    const r = linkRepo(root, repoLink(root, loadRepoConfig(root), { remote: REMOTE }), { name: 'api', remote: REMOTE, dryRun: true });
    assert.match(r.changes.join(), /would add id/);
    assert.ok(!fs.existsSync(path.join(root, 'pulpfixer.json')));
    assert.equal(listRepoRecords().length, 0);
  });
});
