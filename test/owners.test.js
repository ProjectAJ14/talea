// Two owners with a repo of the same name, and a repo marked `ignore: true`,
// through every command that keys, selects or touches a checkout. Real git;
// every origin is a local bare repo, so nothing reaches a network.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

// Set before the imports: config.js reads home on load.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const clone = await import('../src/commands/clone.js');
const sync = await import('../src/commands/sync.js');
const add = await import('../src/commands/add.js');
const adopt = await import('../src/commands/adopt.js');
const exec = await import('../src/commands/exec.js');
const status = await import('../src/commands/status.js');
const ws_ = await import('../src/workspace.js');
const { matchRepo } = await import('../src/adopt.js');
const { repoId, repoLabel } = await import('../src/config.js');
const prompt = await import('../src/prompt.js');

const git = (args, cwd = tmp) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
let n = 0;
before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-owners-')));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A bare origin on `main` with one commit, at `<owner>/<name>.git`. */
function makeOrigin(owner, name) {
  const bare = path.join(tmp, 'origins', String(++n), owner, `${name}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(tmp, 'seeds', String(n));
  git(['clone', '-q', bare, seed]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
  writeFileSync(path.join(seed, 'OWNER'), `${owner}\n`);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'seed'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  return bare;
}

function workspace(repos, state) {
  const ws = path.join(tmp, `ws-${++n}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'talea.repos.json'), JSON.stringify({ repos }));
  writeFileSync(path.join(ws, '.talea.json'), JSON.stringify(state));
  return ws;
}
const readState = (ws) => JSON.parse(readFileSync(path.join(ws, '.talea.json'), 'utf8'));
const ownerOf = (dir) => readFileSync(path.join(dir, 'OWNER'), 'utf8').trim();

async function inWs(ws, fn) {
  const out = [];
  const saved = { log: console.log, error: console.error, exit: process.exit, cwd: process.cwd() };
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  process.exit = (code) => {
    throw new Error(`exit ${code}`);
  };
  let error = null;
  let exitCode;
  try {
    process.chdir(ws);
    await fn();
  } catch (err) {
    error = err;
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.exit = saved.exit;
    process.chdir(saved.cwd);
    exitCode = process.exitCode ?? 0;
    process.exitCode = 0;
  }
  return { text: stripVTControlCharacters(out.join('\n')), error, exitCode };
}

describe('two owners, one repo name', () => {
  let ws;
  let alice;
  let bob;
  before(() => {
    alice = makeOrigin('alice', 'app');
    bob = makeOrigin('bob', 'app');
    ws = workspace(
      [
        { name: 'app', owner: 'alice', url: alice },
        { name: 'app', owner: 'bob', url: bob },
      ],
      { selected: ['alice/app', 'bob/app'] },
    );
    // A stray checkout of each, somewhere in the workspace.
    git(['clone', '-q', alice, path.join(ws, 'stray-a', 'app')]);
    git(['clone', '-q', bob, path.join(ws, 'stray-b', 'app')]);
  });

  test('each checkout is moved to its own place, and neither is parked as the other', async () => {
    const res = await inWs(ws, () => clone.run({ jobs: 1 }));
    assert.equal(res.error, null, res.text);
    assert.equal(ownerOf(path.join(ws, 'alice', 'app')), 'alice');
    assert.equal(ownerOf(path.join(ws, 'bob', 'app')), 'bob');
    assert.equal(existsSync(path.join(ws, '.talea-duplicates')), false, 'one owner was parked as the other');
    // The move log says whose repo moved.
    assert.deepEqual(readState(ws).adopted.map((a) => a.repo).sort(), ['alice/app', 'bob/app']);
  });

  test('sync gives each its own row, and a bare name that means both stops', async () => {
    const res = await inWs(ws, () => sync.run({ jobs: 2 }));
    assert.equal(res.error, null, res.text);
    assert.match(res.text, /alice\/app/);
    assert.match(res.text, /bob\/app/);

    const one = await inWs(ws, () => sync.run({ repo: 'bob/app', jobs: 1 }));
    assert.equal(one.error, null, one.text);
    assert.doesNotMatch(one.text, /alice/);

    const both = await inWs(ws, () => sync.run({ repo: 'app', jobs: 1 }));
    assert.match(both.error.message, /exit 1/);
    assert.match(both.text, /"app" is ambiguous — name the owner too: alice\/app, bob\/app/);
  });

  test('rm of one owner keeps the other, and add puts it back alone', async () => {
    let res = await inWs(ws, () => add.run({ removing: true }, ['alice/app']));
    assert.equal(res.error, null, res.text);
    assert.deepEqual(readState(ws).selected, ['bob/app']);
    assert.match(res.text, /alice\/app off the list/);

    res = await inWs(ws, () => add.run({}, ['alice/app']));
    assert.deepEqual(readState(ws).selected, ['bob/app', 'alice/app']);
    res = await inWs(ws, () => add.run({}, ['alice/app']));
    assert.match(res.text, /alice\/app is already on this machine's list/);
  });

  test('the picker tree labels them apart when they share a group, and ticks only the one chosen', () => {
    const manifest = {
      repos: [
        { name: 'app', owner: 'alice', group: 'work' },
        { name: 'app', owner: 'bob', group: 'work' },
        { name: 'web', owner: 'alice', group: 'work' },
      ],
    };
    const rows = prompt.buildTree(manifest, manifest.repos, (r) => r === manifest.repos[0]);
    const repos = rows.filter((r) => r.kind === 'repo');
    assert.deepEqual(repos.map((r) => r.label), ['alice/app', 'bob/app', 'web']);
    assert.deepEqual(prompt.selectedRepos(rows).map(repoId), ['alice/app']);

    // Typed: an owner/name ticks one; a bare name two owners share is refused.
    let typed = prompt.applyNames(rows, ['bob/app', 'web']);
    assert.deepEqual(typed.picked.map(repoId), ['bob/app', 'alice/web']);
    typed = prompt.applyNames(rows, ['app', 'nope']);
    assert.deepEqual(typed.unknown, ['nope']);
    assert.match(typed.refused[0], /app is ambiguous — name the owner: alice\/app, bob\/app/);
    assert.deepEqual(prompt.applyNames(rows, ['work']).picked.length, 3);
  });

  test('labels name the owner only when the catalogue has two', () => {
    const manifest = { repos: [{ name: 'app', owner: 'alice' }, { name: 'App', owner: 'bob' }, { name: 'web', owner: 'alice' }] };
    assert.equal(repoLabel(manifest, manifest.repos[0]), 'alice/app');
    assert.equal(repoLabel(manifest, manifest.repos[2]), 'web');
    assert.equal(repoLabel(undefined, { name: 'web' }), 'web');
    assert.equal(repoId({ name: 'Web', owner: 'Alice' }), 'alice/web');
    assert.equal(repoId({ name: 'Web' }), 'web');
  });
});

describe('a selection written as bare names', () => {
  const manifest = {
    repos: [
      { name: 'app', owner: 'alice' },
      { name: 'app', owner: 'bob' },
      { name: 'lib', owner: 'me' },
    ],
  };

  test('a name one repo has still counts; one two owners share keeps neither, and says so once', async () => {
    const errors = [];
    const saved = console.error;
    console.error = (s) => errors.push(stripVTControlCharacters(String(s)));
    try {
      assert.deepEqual(ws_.machineRepos(manifest, { selected: ['lib', 'app', 'gone'] }).map(repoId), ['me/lib']);
      ws_.machineRepos(manifest, { selected: ['app'] });
    } finally {
      console.error = saved;
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"app" in this machine's list could be alice\/app or bob\/app, so neither is kept — `talea add alice\/app` to choose/);
  });

  test('a bare name an ignored or missing entry shares still means the one live repo', () => {
    const m = {
      repos: [
        { name: 'app', owner: 'alice' },
        { name: 'app', owner: 'bob', ignore: true },
        { name: 'lib', owner: 'old', missing: true },
        { name: 'lib', owner: 'neworg' },
      ],
    };
    assert.deepEqual(ws_.machineRepos(m, { selected: ['app', 'lib'] }).map(repoId), ['alice/app', 'neworg/lib']);
    assert.deepEqual(ws_.lookup(m, 'bob/app').map(repoId), ['bob/app']);
  });

  test('rm of a bare entry two owners share drops it as written', async () => {
    const ws = workspace(
      [
        { name: 'app', owner: 'alice', url: path.join(tmp, 'a.git') },
        { name: 'app', owner: 'bob', url: path.join(tmp, 'b.git') },
      ],
      { selected: ['app', 'bob/app'] },
    );
    const res = await inWs(ws, () => add.run({ removing: true }, ['app']));
    assert.equal(res.error, null, res.text);
    assert.match(res.text, /app off the list — it named no one repo/);
    assert.deepEqual(readState(ws).selected, ['bob/app']);
    // Not on the list as written, it is still ambiguous.
    const again = await inWs(ws, () => add.run({ removing: true }, ['app']));
    assert.match(again.text, /"app" is ambiguous/);
  });

  test('add and rm rewrite what they can pin down, and keep the rest as written', async () => {
    assert.deepEqual(ws_.selectionIds(manifest, { selected: ['lib', 'app', 'gone', 'me/lib'] }), ['me/lib', 'app', 'gone']);
    // Never asked: the defaults, as ids.
    assert.deepEqual(ws_.selectionIds({ repos: [{ name: 'lib', owner: 'me', default: true }, { name: 'x', owner: 'me' }] }, {}), ['me/lib']);
    const alice = makeOrigin('alice', 'app');
    const ws = workspace(
      [
        { name: 'app', owner: 'alice', url: alice },
        { name: 'app', owner: 'bob', url: path.join(tmp, 'nowhere.git') },
        { name: 'lib', owner: 'me', url: path.join(tmp, 'nowhere-lib.git') },
      ],
      { selected: ['app', 'gone'] },
    );
    // Naming the owner answers the question the bare entry could not.
    const res = await inWs(ws, () => add.run({ jobs: 1 }, ['alice/app']));
    assert.equal(res.error, null, res.text);
    assert.deepEqual(readState(ws).selected, ['gone', 'alice/app']);
    assert.equal(ownerOf(path.join(ws, 'alice', 'app')), 'alice');
  });
});

describe('ignore: true, at every way in', () => {
  let ws;
  let mine;
  let theirs;
  const catalogue = () => [
    { name: 'app', owner: 'alice', url: mine },
    { name: 'app', owner: 'bob', url: theirs, ignore: true },
    { name: 'vendored', owner: 'bob', url: theirs, ignore: true, group: 'other' },
  ];
  before(() => {
    mine = makeOrigin('alice', 'app');
    theirs = makeOrigin('bob', 'app');
    ws = workspace(catalogue(), { selected: ['alice/app', 'bob/app'] });
    // Another tool's checkout of the ignored repo, inside the workspace.
    git(['clone', '-q', theirs, path.join(ws, 'managed', 'app')]);
  });

  test('matchRepo: an exact match to a repo outside the pool is that repo, never a name match on this one', () => {
    const manifest = { repos: catalogue() };
    const pool = [manifest.repos[0]];
    assert.equal(matchRepo(manifest, pool, theirs), null);
    assert.deepEqual(matchRepo(manifest, pool, mine), { repo: pool[0], confidence: 'exact' });
    // From a mirror, the name is counted across the whole catalogue: bob/app
    // is a live repo of that name even though ignored or narrowed away, so
    // a mirror's `app` is nobody's. With alice's the only one, it is hers.
    const mirror = 'https://mirror/x/app.git';
    assert.equal(matchRepo(manifest, pool, mirror), null);
    assert.equal(matchRepo(manifest, manifest.repos.slice(0, 2), mirror), null);
    const alone = { repos: [manifest.repos[0]] };
    assert.equal(matchRepo(alone, alone.repos, mirror).confidence, 'name');
  });

  test('matchRepo: a checkout of a repo that moved owners still matches the new one by name', () => {
    // discover keeps the old entry, marked missing (rule 11); its URL redirects.
    const moved = { repos: [{ name: 'lib', owner: 'old', url: 'https://h/old/lib.git', missing: true }, { name: 'lib', owner: 'new', url: 'https://h/new/lib.git' }] };
    const kept = [moved.repos[1]];
    assert.deepEqual(matchRepo(moved, kept, 'https://h/old/lib.git'), { repo: kept[0], confidence: 'name' });
  });

  test('clone, sync and adopt --loose never move or park the other tool\'s checkout', async () => {
    let res = await inWs(ws, () => clone.run({ jobs: 1 }));
    assert.equal(res.error, null, res.text);
    assert.equal(ownerOf(path.join(ws, 'alice', 'app')), 'alice', 'alice/app was not cloned');
    assert.equal(existsSync(path.join(ws, 'bob')), false, 'the ignored repo was cloned');
    res = await inWs(ws, () => sync.run({ jobs: 1 }));
    assert.equal(res.error, null, res.text);
    res = await inWs(ws, () => adopt.run({ loose: true, apply: true }));
    assert.equal(res.error, null, res.text);
    assert.equal(ownerOf(path.join(ws, 'managed', 'app')), 'bob', 'the other tool\'s checkout moved');
    assert.equal(existsSync(path.join(ws, '.talea-duplicates')), false, 'the other tool\'s checkout was parked');
  });

  test('add refuses it, and nothing is written or cloned', async () => {
    const before = readState(ws).selected;
    const res = await inWs(ws, () => add.run({}, ['vendored']));
    assert.match(res.error.message, /exit 1/);
    assert.match(res.text, /vendored is marked ignore: true — another tool owns that checkout, so talea will not keep it/);
    assert.deepEqual(readState(ws).selected, before);
    assert.equal(existsSync(path.join(ws, 'other')), false);
  });

  test('exec --all and status --all leave its checkout alone, named or not', async () => {
    // Where talea would put it, if it were talea's.
    git(['clone', '-q', theirs, path.join(ws, 'other', 'vendored')]);
    let res = await inWs(ws, () => exec.run({ all: true }, ['git', 'rev-parse', '--show-toplevel']));
    assert.equal(res.error, null, res.text);
    assert.doesNotMatch(res.text, /vendored/);
    res = await inWs(ws, () => exec.run({ all: true, repo: 'vendored' }, ['git', 'status']));
    assert.match(res.text, /vendored is marked ignore: true/);
    assert.match(res.text, /in 0 repos/);
    res = await inWs(ws, () => status.run({ all: true }));
    assert.doesNotMatch(res.text, /vendored/);
  });

  test('the picker lists it as unavailable, and no key ticks it', () => {
    const manifest = { repos: catalogue() };
    const rows = prompt.buildTree(manifest, manifest.repos, true);
    const ignored = rows.findIndex((r) => r.kind === 'repo' && r.repo.name === 'vendored');
    assert.equal(rows[ignored].ignored, true);
    assert.equal(rows[ignored].checked, false, 'preselected');
    prompt.toggle(rows, ignored);
    assert.equal(rows[ignored].checked, false, 'space ticked it');
    prompt.toggle(rows, ignored - 1); // its group
    assert.equal(rows[ignored].checked, false, 'the group ticked it');
    assert.equal(prompt.groupState(rows, 'other'), 'none');
    prompt.setAll(rows, true);
    assert.deepEqual(prompt.selectedRepos(rows).map(repoId), ['alice/app']);
    assert.match(stripVTControlCharacters(prompt.renderRow(rows, ignored, 0)), /– vendored {2}ignored — another tool owns it/);
    const typed = prompt.applyNames(rows, ['vendored']);
    assert.deepEqual(typed.picked, []);
    assert.match(typed.refused[0], /vendored is marked ignore: true/);
  });
});

describe('a second copy that matches on name only', () => {
  test('clone leaves it where it is and says so, rather than parking it unattended', async () => {
    const origin = makeOrigin('me', 'app');
    const ws = workspace([{ name: 'app', owner: 'me', url: origin }], { selected: ['me/app'] });
    git(['clone', '-q', origin, path.join(ws, 'me', 'app')]);
    // The same repo from a host the catalogue does not list.
    const mirror = path.join(tmp, 'mirror', 'app.git');
    mkdirSync(path.dirname(mirror), { recursive: true });
    git(['clone', '-q', '--bare', origin, mirror]);
    git(['clone', '-q', mirror, path.join(ws, 'elsewhere', 'app')]);

    const res = await inWs(ws, () => clone.run({ jobs: 1 }));
    assert.equal(res.error, null, res.text);
    assert.match(res.text, /a second copy of app at .*elsewhere.app left alone — its remote host is not one the catalogue lists/);
    assert.equal(existsSync(path.join(ws, 'elsewhere', 'app', '.git')), true);
    assert.equal(existsSync(path.join(ws, '.talea-duplicates')), false);

  });
});
