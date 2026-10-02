// src/adopt.js — matching, planning, moving and path repair, against real git.
//
// Every repo is throwaway and local; origins are bare repos on disk, so nothing
// reaches a network. Failures that the filesystem will not produce on demand
// (a cross-device rename, a locked file on Windows) are forced by swapping the
// `node:fs` / `node:child_process` export for one call and re-syncing the ESM
// bindings, then putting it straight back.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import cp from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Set before the import: config.js reads home on load, and the Claude repairs
// read ~/.claude* — keep both off the developer's own.
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-adopt-home-')));
process.env.HOME = process.env.USERPROFILE = home;
const A = await import('../src/adopt.js');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-adopt-')));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
const fresh = (name = 'd') => {
  const dir = path.join(tmp, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Replace one builtin export for the length of `fn`. */
async function stubbed(mod, name, make, fn) {
  const orig = mod[name];
  mod[name] = make(orig);
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    mod[name] = orig;
    syncBuiltinESMExports();
  }
}

async function onPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

const errno = (code) => Object.assign(new Error(code), { code });

/** A clone of a bare origin, with one commit on main. */
function makeRepo(name, parent = fresh('p')) {
  const origin = path.join(fresh('o'), `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', origin], tmp);
  const dir = path.join(parent, name);
  git(['clone', '-q', origin, dir], tmp);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['checkout', '-q', '-b', 'main'], dir);
  writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);
  return { dir, origin };
}

describe('lines and samePath', () => {
  test('lines drops blanks and \\r', () => {
    assert.deepEqual(A.lines('a\r\nb\n\n'), ['a', 'b']);
  });

  test('samePath folds case only where the filesystem does', async () => {
    assert.equal(A.samePath('', '/x'), false);
    assert.equal(A.samePath('/x', null), false);
    await onPlatform('linux', () => assert.equal(A.samePath('/a/B', '/a/b'), false));
    await onPlatform('darwin', () => assert.equal(A.samePath('/a/B', '/a/b'), true));
    await onPlatform('win32', () => assert.equal(A.samePath('/a/B', '/a/b'), true));
  });
});

describe('normalizeUrl and friends', () => {
  test('the same repo spelled every way compares equal', () => {
    const want = 'github.com/me/x';
    for (const u of [
      'git@github.com:me/x.git',
      'https://github.com/me/x',
      'ssh://git@github.com:22/me/x.git',
      'https://user:pw@GitHub.com/me/x/',
      'https://github.com//me/x.git',
    ]) {
      assert.equal(A.normalizeUrl(u), want, u);
    }
    assert.equal(A.normalizeUrl('C:\\src\\x'), A.normalizeUrl('C:/src/x'));
  });

  test('a malformed escape falls back to the raw form', () => {
    assert.equal(A.normalizeUrl('https://h/%E0%A4%A/x'), 'h/%e0%a4%a/x');
  });

  test('nothing in, nothing out', () => {
    assert.equal(A.normalizeUrl(''), null);
    assert.equal(A.urlRepoName(null), null);
    assert.equal(A.urlRepoName('git@h:me/Repo.git'), 'repo');
  });

  test('catalogueUrls: the override, every known protocol, and not a broken one', () => {
    const manifest = { remotes: { ssh: 'git@h:{owner}/{repo}.git', https: 'https://h/{owner}/{repo}', bad: '' } };
    assert.deepEqual(A.catalogueUrls(manifest, { name: 'x', owner: 'me', url: 'u' }), [
      'u',
      'git@h:me/x.git',
      'https://h/me/x',
    ]);
    assert.deepEqual(A.catalogueUrls({}, { name: 'x' }), []);
  });

  test('matchRepo: exact, then name, then nothing', () => {
    const manifest = { remotes: { ssh: 'git@h:{owner}/{repo}.git' } };
    const repos = [{ name: 'x', owner: 'me' }, { name: 'Y', owner: 'me' }];
    assert.equal(A.matchRepo(manifest, repos, null), null);
    assert.deepEqual(A.matchRepo(manifest, repos, 'https://h/me/x'), { repo: repos[0], confidence: 'exact' });
    assert.deepEqual(A.matchRepo(manifest, repos, 'https://mirror/fork/y.git'), {
      repo: repos[1],
      confidence: 'name',
    });
    assert.equal(A.matchRepo(manifest, repos, 'https://h/me/z'), null);
  });
});

describe('finding checkouts', () => {
  test('isLinkedWorktree tells a .git file from a .git folder', () => {
    const d = fresh();
    assert.equal(A.isLinkedWorktree(d), false);
    mkdirSync(path.join(d, '.git'));
    assert.equal(A.isLinkedWorktree(d), false);
    const w = fresh();
    writeFileSync(path.join(w, '.git'), 'gitdir: /x\n');
    assert.equal(A.isLinkedWorktree(w), true);
  });

  test('findGitDirs stops at repos, skips noise, honours depth', () => {
    const root = fresh('scan');
    const mk = (...p) => mkdirSync(path.join(root, ...p, '.git'), { recursive: true });
    mk('a');
    mk('a', 'inner'); // inside a repo: never looked for
    mk('g', 'b');
    mk('node_modules', 'c');
    mk('.hidden', 'd');
    mk('1', '2', '3', 'too-deep');
    writeFileSync(path.join(root, 'file.txt'), '');
    const asFile = path.join(root, 'file.txt');
    const found = A.findGitDirs([root, root, asFile, path.join(root, 'missing')]);
    assert.deepEqual(found.sort(), [path.join(root, 'a'), path.join(root, 'g', 'b')].sort());
    assert.deepEqual(A.findGitDirs([root], 1), [path.join(root, 'a')]);
  });

  test('readOrigins keeps order and reports a missing origin as null', async () => {
    const { dir, origin } = makeRepo('r');
    const bare = fresh();
    git(['init', '-q'], bare);
    const got = await A.readOrigins([dir, bare], 2);
    assert.equal(got[0].dir, dir);
    assert.equal(A.normalizeUrl(got[0].originUrl), A.normalizeUrl(origin));
    assert.deepEqual(got[1], { dir: bare, originUrl: null });
  });
});

describe('moveBlockers and canonical', () => {
  test('a linked worktree or a folder without .git is not moved', async () => {
    const w = fresh();
    writeFileSync(path.join(w, '.git'), 'gitdir: /x\n');
    assert.match(await A.moveBlockers(w), /linked worktree/);
    assert.equal(await A.moveBlockers(fresh()), 'no .git found');
    const r = fresh();
    mkdirSync(path.join(r, '.git'));
    assert.equal(await A.moveBlockers(r), null);
  });

  test('canonical re-attaches the part of the path that does not exist yet', () => {
    const d = fresh();
    assert.equal(A.canonical(path.join(d, 'no', 'such')), path.join(realpathSync.native(d), 'no', 'such'));
  });

  test('canonical gives up at the root and returns the resolved input', () => {
    const orig = realpathSync.native;
    realpathSync.native = () => {
      throw errno('ENOENT');
    };
    try {
      assert.equal(A.canonical('/x/y'), path.resolve('/x/y'));
    } finally {
      realpathSync.native = orig;
    }
  });
});

describe('worktree records', () => {
  test('locked (with its reason), detached and prunable are all read', () => {
    const porcelain = [
      'worktree /r\nHEAD a\nbranch refs/heads/main',
      'worktree /r-worktrees/x\nHEAD b\ndetached\nlocked reason',
      'worktree /gone\nHEAD c\nbranch refs/heads/g\nprunable gitdir points nowhere',
      'worktree /bare-lock\nHEAD d\nbranch refs/heads/d\nlocked',
      'not a worktree block',
    ].join('\n\n');
    assert.deepEqual(A.worktreeRecords(porcelain), [
      { path: '/r', head: 'a', branch: 'main', locked: false, lockReason: null, prunable: false },
      { path: '/r-worktrees/x', head: 'b', branch: null, locked: true, lockReason: 'reason', prunable: false },
      { path: '/gone', head: 'c', branch: 'g', locked: false, lockReason: null, prunable: true },
      { path: '/bare-lock', head: 'd', branch: 'd', locked: true, lockReason: null, prunable: false },
    ]);
    assert.deepEqual(A.worktreeRecords('worktree /r'), [
      { path: '/r', head: null, branch: null, locked: false, lockReason: null, prunable: false },
    ]);
  });

  test('the repo folder itself is not remapped as if nested in itself', () => {
    const from = path.join(tmp, 'old');
    assert.equal(A.remapWorktree(from, { from, to: path.join(tmp, 'new'), siblings: null }), from);
  });

  test('readWorktrees on something that is not a repo is an error, never "none"', () => {
    assert.match(A.readWorktrees(fresh()).error, /not a git repository/);
    assert.match(A.readWorktrees(path.join(tmp, 'no-such-dir')).error, /ENOENT/);
  });
});

describe('uniqueWork', () => {
  test('a clean copy with nothing new holds nothing', async () => {
    const { dir } = makeRepo('clean');
    const other = path.join(fresh(), 'copy');
    git(['clone', '-q', dir, other], tmp);
    assert.deepEqual(await A.uniqueWork(other, dir), []);
  });

  test('one of each, and several of each', async () => {
    const { dir } = makeRepo('busy');
    const winner = fresh();
    git(['init', '-q'], winner); // knows none of the loser's commits
    writeFileSync(path.join(dir, 'a.txt'), '1');
    assert.deepEqual(await A.uniqueWork(dir, winner), [
      '1 uncommitted change',
      'commits the other copy does not have (main)',
    ]);
    git(['add', 'a.txt'], dir);
    git(['stash', '-q'], dir);
    writeFileSync(path.join(dir, 'README.md'), 'changed');
    writeFileSync(path.join(dir, 'b.txt'), '2');
    git(['stash', '-q', '-u'], dir);
    writeFileSync(path.join(dir, 'README.md'), 'changed');
    writeFileSync(path.join(dir, 'c.txt'), '3');
    assert.deepEqual(await A.uniqueWork(dir, winner), [
      '2 uncommitted changes',
      '2 stashes',
      'commits the other copy does not have (main)',
    ]);
  });

  test('a winner git cannot read counts every branch as missing', async () => {
    const { dir } = makeRepo('lonely');
    writeFileSync(path.join(dir, 'README.md'), 'changed');
    git(['stash', '-q'], dir);
    assert.deepEqual(await A.uniqueWork(dir, path.join(tmp, 'no-such-dir')), [
      '1 stash',
      'commits the other copy does not have (main)',
    ]);
  });

  test('a repo with no commits has no branches to check', async () => {
    const empty = fresh();
    git(['init', '-q'], empty);
    assert.deepEqual(await A.uniqueWork(empty, empty), []);
  });
});

describe('parkingSpot', () => {
  test('uses the group dir, suffixes rather than overwrites, and never runs out', () => {
    const root = fresh('ws');
    const manifest = { groups: { me: { dir: 'mine' } } };
    const repo = { name: 'x', owner: 'me' };
    const base = path.join(root, A.DUPLICATES_DIR, 'mine', 'x');
    assert.equal(A.parkingSpot(root, repo, manifest), base);
    assert.equal(A.parkingSpot(root, { ...repo, dir: 'y' }), path.join(root, A.DUPLICATES_DIR, 'me', 'y'));
    mkdirSync(base, { recursive: true });
    assert.equal(A.parkingSpot(root, repo, manifest), `${base}-2`);
    for (let n = 2; n < 100; n++) mkdirSync(`${base}-${n}`);
    assert.match(A.parkingSpot(root, repo, manifest), new RegExp(`x-\\d{13}$`));
  });
});

describe('planAdoptions', () => {
  const manifest = (repos) => ({ repos, groups: {} });

  test('in place, moves, parks, and what does not match', async () => {
    const root = fresh('ws');
    const { dir: atTarget, origin } = makeRepo('app', path.join(root, 'me'));
    const outside = path.join(fresh('stray'), 'app');
    git(['clone', '-q', origin, outside], tmp);
    const wt = path.join(fresh(), 'wt');
    git(['worktree', 'add', '-q', '-b', 'wt', wt], atTarget);
    const inside = path.join(root, 'elsewhere', 'app');
    git(['clone', '-q', origin, inside], tmp);

    const repo = { name: 'app', owner: 'me', url: origin };
    const plans = await A.planAdoptions(manifest([repo]), root, [repo], [
      { dir: outside, originUrl: origin },
      { dir: wt, originUrl: origin },
      { dir: atTarget, originUrl: origin },
      { dir: inside, originUrl: origin },
      { dir: fresh(), originUrl: 'https://h/someone/else' },
    ]);
    assert.deepEqual(
      plans.map((p) => [p.action, p.from]),
      [
        ['in-place', atTarget],
        ['park', inside],
        ['park', outside],
      ],
    );
    assert.equal(plans[1].keeping, atTarget);
    assert.deepEqual(plans[1].holds, []);
  });

  test('copies at the same rank are ordered by path', async () => {
    const root = fresh('ws');
    const { origin } = makeRepo('app');
    const b = path.join(root, 'b', 'app');
    const a = path.join(root, 'a', 'app');
    git(['clone', '-q', origin, b], tmp);
    git(['clone', '-q', origin, a], tmp);
    const repo = { name: 'app', owner: 'me', url: origin };
    const plans = await A.planAdoptions(manifest([repo]), root, [repo], [
      { dir: b, originUrl: origin },
      { dir: a, originUrl: origin },
    ]);
    assert.deepEqual(plans.map((p) => [p.action, p.from]), [
      ['move', a],
      ['park', b],
    ]);
    assert.equal(plans[1].keeping, path.join(root, 'me', 'app'));
  });

  test('an occupied destination refuses the winner and holds every duplicate', async () => {
    const root = fresh('ws');
    const { origin } = makeRepo('app');
    mkdirSync(path.join(root, 'me', 'app'), { recursive: true });
    writeFileSync(path.join(root, 'me', 'app', 'THEIRS'), '');
    const one = path.join(fresh('zz'), 'app');
    git(['clone', '-q', origin, one], tmp);
    const repo = { name: 'app', owner: 'me', url: origin };
    // The workspace root itself as a copy: the message names it absolutely.
    const plans = await A.planAdoptions(manifest([repo]), root, [repo], [
      { dir: root, originUrl: origin },
      { dir: one, originUrl: origin },
    ]);
    assert.equal(plans[0].action, 'refuse');
    assert.equal(plans[0].reason, 'destination already exists and is not empty');
    assert.equal(plans[1].action, 'refuse');
    assert.match(plans[1].reason, new RegExp(`but ${root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} could not be moved`));
  });

  test('a destination that is a file cannot be read, and an empty one is free', async () => {
    const root = fresh('ws');
    const { dir, origin } = makeRepo('app');
    const repo = { name: 'app', owner: 'me', url: origin };
    mkdirSync(path.join(root, 'me'));
    writeFileSync(path.join(root, 'me', 'app'), '');
    let plans = await A.planAdoptions(manifest([repo]), root, [repo], [{ dir, originUrl: origin }]);
    assert.equal(plans[0].reason, 'destination exists and cannot be read');

    rmSync(path.join(root, 'me', 'app'));
    mkdirSync(path.join(root, 'me', 'app'));
    plans = await A.planAdoptions(manifest([repo]), root, [repo], [{ dir, originUrl: origin }]);
    assert.equal(plans[0].action, 'move');
  });

  test('a duplicate with no .git is refused, not parked', async () => {
    const root = fresh('ws');
    const { dir, origin } = makeRepo('app', path.join(root, 'me'));
    const hollow = fresh('hollow');
    const repo = { name: 'app', owner: 'me', url: origin };
    const plans = await A.planAdoptions(manifest([repo]), root, [repo], [
      { dir, originUrl: origin },
      { dir: hollow, originUrl: origin },
    ]);
    assert.equal(plans[1].action, 'refuse');
    assert.equal(plans[1].reason, 'a second copy, but no .git found');
  });
});

describe('executeMove', () => {
  test('a repo with no worktrees moves with nothing to repair; a folder git cannot read does not move', () => {
    const { dir } = makeRepo('plain');
    const to = path.join(fresh(), 'deep', 'x');
    const res = A.executeMove({ from: dir, to });
    assert.deepEqual(res, { ok: true, to, worktrees: { repaired: [], broken: [], siblings: null, stale: 0 } });
    const notRepo = fresh();
    const refused = A.executeMove({ from: notRepo, to: path.join(fresh(), 'y') });
    assert.equal(refused.ok, false);
    assert.equal(existsSync(notRepo), true);
  });

  test('a locked worktree whose folder is gone is counted stale, not repaired', () => {
    const { dir } = makeRepo('stale');
    const wt = path.join(fresh(), 'gone');
    git(['worktree', 'add', '-q', '-b', 'gone', wt], dir);
    git(['worktree', 'lock', wt], dir);
    rmSync(wt, { recursive: true, force: true });
    const to = path.join(fresh(), 'stale');
    const res = A.executeMove({ from: dir, to });
    assert.equal(res.ok, true);
    assert.deepEqual(res.worktrees, { repaired: [], broken: [], siblings: null, stale: 1 });
  });

  test('a case-only rename does not try to move the sibling folder onto itself', async () => {
    const { dir } = makeRepo('Case');
    git(['worktree', 'add', '-q', '-b', 's', path.join(A.siblingWorktreeDir(dir), 's')], dir);
    const to = path.join(path.dirname(dir), 'case');
    const res = await onPlatform('darwin', () => A.executeMove({ from: dir, to }));
    assert.equal(res.ok, true, res.message);
    assert.equal(res.worktrees.siblings, null);
  });

  test('a sibling folder that will not move leaves its worktrees repaired in place', async () => {
    const { dir } = makeRepo('sib');
    const sib = path.join(A.siblingWorktreeDir(dir), 's');
    git(['worktree', 'add', '-q', '-b', 's', sib], dir);
    const to = path.join(fresh(), 'sib');
    const res = await stubbed(
      fs,
      'renameSync',
      (orig) => (a, b) => {
        if (String(a).endsWith('-worktrees')) throw errno('EBUSY');
        return orig(a, b);
      },
      () => A.executeMove({ from: dir, to }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.worktrees.siblings, null);
    assert.equal(res.worktrees.repaired.length, 1);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], sib), 'true');
  });

  test('a GIT_DIR left in the environment does not change which worktrees move or get re-linked', async () => {
    // Found in review: git exports GIT_DIR into hooks, and a talea run from
    // one read the other repo's worktree list, moved this one, and said ok.
    const { dir } = makeRepo('scoped');
    const other = makeRepo('other');
    const far = path.join(fresh(), 'far');
    git(['worktree', 'add', '-q', '-b', 'far', far], dir);
    const to = path.join(fresh(), 'scoped');
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other.dir, '.git');
    let res;
    try {
      res = A.executeMove({ from: dir, to });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.worktrees.repaired, [far]);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], far), 'true');
    assert.equal(realpathSync(git(['rev-parse', '--git-common-dir'], far)), realpathSync(path.join(to, '.git')));
  });

  test('a worktree list git cannot give refuses the move; nothing is renamed', async () => {
    const { dir } = makeRepo('unlisted');
    const to = path.join(fresh(), 'unlisted');
    const res = await stubbed(cp, 'spawnSync', (orig) => (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'worktree' && args[1] === 'list' ? { status: 128, stdout: '', stderr: 'fatal: boom' } : orig(cmd, args, opts),
      () => A.executeMove({ from: dir, to }),
    );
    assert.equal(res.ok, false);
    assert.match(res.message, /could not list its worktrees \(fatal: boom\) — nothing was moved/);
    // A git that fails saying nothing still gets a reason.
    const silent = await stubbed(cp, 'spawnSync', () => () => ({ status: 1, stdout: '', stderr: '' }), () => A.readWorktrees(dir));
    assert.deepEqual(silent, { error: 'git exited 1' });
    assert.equal(existsSync(dir), true);
    assert.equal(existsSync(to), false);
  });

  test('a repair that does not take is reported as broken, with the command that fixes it', async () => {
    const { dir } = makeRepo('unrepaired');
    const far = path.join(fresh(), 'far');
    git(['worktree', 'add', '-q', '-b', 'far', far], dir);
    const to = path.join(fresh(), 'unrepaired');
    const res = await stubbed(cp, 'spawnSync', (orig) => (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'worktree' && args[1] === 'repair' ? { status: 1, stdout: '', stderr: 'nope' } : orig(cmd, args, opts),
      () => A.executeMove({ from: dir, to }),
    );
    // The repo moved — that part is done and nothing is undone.
    assert.equal(res.ok, true);
    assert.equal(existsSync(path.join(to, '.git')), true);
    assert.deepEqual(res.worktrees.repaired, []);
    assert.deepEqual(res.worktrees.broken, [{ path: far, why: 'nope' }]);
    // And the command it names really does fix it.
    git(['worktree', 'repair', far], to);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], far), 'true');
  });

  test('a worktree git cannot write is named in every failure it causes, and the printed fix works once it is writable', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const { dir } = makeRepo('halfway');
    const stuck = path.join(fresh(), 'stuck');
    const fine = path.join(fresh(), 'fine');
    git(['worktree', 'add', '-q', '-b', 'stuck', stuck], dir);
    git(['worktree', 'add', '-q', '-b', 'fine', fine], dir);
    // git rewrites every worktree's link on any repair, so this one fails both.
    fs.chmodSync(path.join(stuck, '.git'), 0o444);
    fs.chmodSync(stuck, 0o555);
    const to = path.join(fresh(), 'halfway');
    let res;
    try {
      res = A.executeMove({ from: dir, to });
    } finally {
      fs.chmodSync(stuck, 0o755);
      fs.chmodSync(path.join(stuck, '.git'), 0o644);
    }
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.worktrees.repaired, []);
    assert.deepEqual(res.worktrees.broken.map((b) => b.path), [stuck, fine]);
    for (const b of res.worktrees.broken) assert.ok(b.why.includes(stuck), `the reason does not name the cause: ${b.why}`);
    // Writable again, the command talea prints finishes it.
    for (const b of res.worktrees.broken) git(['worktree', 'repair', b.path], to);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], fine), 'true');
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], stuck), 'true');
  });

  const failing = (code) => (fn) =>
    stubbed(fs, 'renameSync', () => () => {
      throw errno(code);
    }, fn);

  test('a cross-device move is refused with the command to run, per platform', async () => {
    const plan = { from: makeRepo('xdev').dir, to: path.join(fresh(), 'x') };
    const posix = await failing('EXDEV')(() => onPlatform('linux', () => A.executeMove(plan)));
    assert.equal(posix.ok, false);
    assert.match(posix.message, /different filesystem[\s\S]*mv "/);
    const win = await failing('EXDEV')(() => onPlatform('win32', () => A.executeMove(plan)));
    assert.match(win.message, /move "/);
    assert.equal(existsSync(plan.from), true);
  });

  test('a held handle names the cause; anything else passes the message through', async () => {
    const plan = { from: makeRepo('busy').dir, to: path.join(fresh(), 'x') };
    const busy = await failing('EBUSY')(() => A.executeMove(plan));
    assert.match(busy.message, /could not be moved \(EBUSY\) — something has it open/);
    const gone = A.executeMove({ from: path.join(tmp, 'nope'), to: path.join(fresh(), 'x') });
    assert.equal(gone.ok, false);
    assert.match(gone.message, /nope is no longer there — nothing was moved/);
    const full = { from: makeRepo('full').dir, to: path.join(fresh(), 'x') };
    const other = await stubbed(fs, 'mkdirSync', () => () => {
      throw errno('ENOSPC');
    }, () => A.executeMove(full));
    assert.equal(other.message, 'ENOSPC');
  });
});

describe('claudeMaybeRunning', () => {
  const answering = (status, stdout) => (fn) =>
    stubbed(cp, 'spawnSync', () => () => ({ status, stdout }), fn);

  test('POSIX asks pgrep', async () => {
    assert.equal(await answering(0)(() => onPlatform('linux', A.claudeMaybeRunning)), true);
    assert.equal(await answering(1)(() => onPlatform('linux', A.claudeMaybeRunning)), false);
  });

  test('Windows asks tasklist and reads its output', async () => {
    const win = (status, out) => answering(status, out)(() => onPlatform('win32', A.claudeMaybeRunning));
    assert.equal(await win(0, 'claude.exe   123 Console'), true);
    assert.equal(await win(0, 'INFO: No tasks are running'), false);
    assert.equal(await win(1, ''), false);
  });
});

describe('moveClaudeSessions', () => {
  const projects = () => path.join(home, '.claude', 'projects');
  const slugDir = (p) => path.join(projects(), A.claudeSlug(p));

  test('nothing to do for the same path or a project with no history', () => {
    assert.deepEqual(A.moveClaudeSessions('/a', '/a'), { changed: false });
    assert.deepEqual(A.moveClaudeSessions(path.join(tmp, 'never'), path.join(tmp, 'x')), { changed: false });
  });

  test('history moves to the new slug', () => {
    const from = path.join(tmp, 'sess-from');
    const to = path.join(tmp, 'sess-to');
    mkdirSync(slugDir(from), { recursive: true });
    writeFileSync(path.join(slugDir(from), 'a.jsonl'), '');
    assert.deepEqual(A.moveClaudeSessions(from, to), { changed: true, merged: false, dir: slugDir(to) });
    assert.equal(existsSync(path.join(slugDir(to), 'a.jsonl')), true);
  });

  test('a failed rename is reported, not thrown', async () => {
    const from = path.join(tmp, 'sess-fail');
    mkdirSync(slugDir(from), { recursive: true });
    const res = await stubbed(fs, 'renameSync', () => () => {
      throw errno('EPERM');
    }, () => A.moveClaudeSessions(from, path.join(tmp, 'sess-fail-to')));
    assert.deepEqual(res, { changed: false, error: 'EPERM' });
  });

  test('an existing new slug is merged into, never overwritten', async () => {
    const from = path.join(tmp, 'merge-from');
    const to = path.join(tmp, 'merge-to');
    mkdirSync(slugDir(from), { recursive: true });
    mkdirSync(slugDir(to), { recursive: true });
    for (const f of ['new', 'both', 'stuck']) writeFileSync(path.join(slugDir(from), f), 'old');
    writeFileSync(path.join(slugDir(to), 'both'), 'mine');
    const res = await stubbed(
      fs,
      'renameSync',
      (orig) => (a, b) => {
        if (path.basename(a) === 'stuck') throw errno('EPERM');
        return orig(a, b);
      },
      () => A.moveClaudeSessions(from, to),
    );
    assert.deepEqual(res, {
      changed: true,
      merged: true,
      moved: 1,
      kept: 2,
      dir: slugDir(to),
      leftBehind: slugDir(from),
    });
    assert.equal(readFileSync(path.join(slugDir(to), 'both'), 'utf8'), 'mine');
  });

  test('a merge that moves nothing reports no change', () => {
    const from = path.join(tmp, 'idle-from');
    const to = path.join(tmp, 'idle-to');
    mkdirSync(slugDir(from), { recursive: true });
    mkdirSync(slugDir(to), { recursive: true });
    assert.equal(A.moveClaudeSessions(from, to).changed, false);
  });
});

describe('rekeyClaudeJson', () => {
  const file = () => path.join(home, '.claude.json');
  const write = (data) => writeFileSync(file(), typeof data === 'string' ? data : JSON.stringify(data));
  const read = () => JSON.parse(readFileSync(file(), 'utf8'));
  const from = path.resolve('/old/app');
  const to = path.resolve('/new/app');

  test('the no-op cases', () => {
    assert.deepEqual(A.rekeyClaudeJson(from, from), { changed: false });
    rmSync(file(), { force: true });
    assert.deepEqual(A.rekeyClaudeJson(from, to), { changed: false });
    write({});
    assert.deepEqual(A.rekeyClaudeJson(from, to), { changed: false });
    write({ projects: {} });
    assert.deepEqual(A.rekeyClaudeJson(from, to), { changed: false });
    write('{nope');
    assert.match(A.rekeyClaudeJson(from, to).error, /could not parse/);
  });

  test('re-keys the entry, keeping the file mode', () => {
    write({ projects: { [from]: { a: 1 } }, other: true });
    fs.chmodSync(file(), 0o600);
    assert.deepEqual(A.rekeyClaudeJson(from, to), { changed: true });
    assert.deepEqual(read(), { projects: { [to]: { a: 1 } }, other: true });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  });

  test('an entry already at the new path wins', () => {
    write({ projects: { [from]: { a: 1 }, [to]: { b: 2 } } });
    assert.match(A.rekeyClaudeJson(from, to).note, /stale entry/);
    assert.deepEqual(read(), { projects: { [to]: { b: 2 } } });
  });

  test('a filesystem without modes is not fatal', async () => {
    write({ projects: { [from]: {} } });
    const res = await stubbed(fs, 'chmodSync', () => () => {
      throw errno('ENOSYS');
    }, () => A.rekeyClaudeJson(from, to));
    assert.deepEqual(res, { changed: true });
  });

  test('a write that fails leaves no temp file and reports the error, in both branches', async () => {
    const tmpFile = `${file()}.talea-tmp`;
    // A directory where the temp file goes: the write fails, and so does the
    // tidy-up (rmSync without recursive will not remove a folder).
    mkdirSync(tmpFile);
    write({ projects: { [from]: {} } });
    assert.equal(A.rekeyClaudeJson(from, to).changed, false);
    write({ projects: { [from]: {}, [to]: {} } });
    assert.ok(A.rekeyClaudeJson(from, to).error);
    rmSync(tmpFile, { recursive: true });

    // A failing rename: the temp file is written, then cleaned up.
    write({ projects: { [from]: {} } });
    const res = await stubbed(fs, 'renameSync', () => () => {
      throw errno('EBUSY');
    }, () => A.rekeyClaudeJson(from, to));
    assert.deepEqual(res, { changed: false, error: 'EBUSY' });
    assert.equal(existsSync(tmpFile), false, 'litter left beside ~/.claude.json');
  });
});

describe('config path repair', () => {
  test('findConfigHits looks in named files, patterns and config folders only', () => {
    const root = fresh('cfg');
    const from = path.join(tmp, 'old-home', 'app');
    const text = `cd ${from}\n${from}-ui is another repo\n`;
    const put = (rel, body = text) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    };
    put('CLAUDE.md');
    put('.env.local');
    put('.talea.json'); // the record --fix-paths replays from: never rewritten
    put('notes.txt');
    put('.idea/runConfigurations/app.xml');
    put('.idea/a/b/c/too-deep.xml');
    put('.vscode/readme.txt');
    put('.cursor', 'a file where a folder is expected');
    mkdirSync(path.join(root, 'sub'));

    const hits = A.findConfigHits([root, root, path.join(root, 'notes.txt'), path.join(tmp, 'absent')], from);
    assert.deepEqual(
      hits.map((h) => [path.relative(root, h.file), h.count]).sort(),
      [
        ['.env.local', 1],
        ['CLAUDE.md', 1],
        [path.join('.idea', 'runConfigurations', 'app.xml'), 1],
      ].sort(),
    );
  });

  test('an unreadable config file is skipped', async () => {
    const root = fresh('cfg');
    writeFileSync(path.join(root, 'AGENTS.md'), '/x');
    const hits = await stubbed(fs, 'readFileSync', () => () => {
      throw errno('EACCES');
    }, () => A.findConfigHits([root], '/x'));
    assert.deepEqual(hits, []);
  });

  test('rewriteConfigFile replaces whole paths only, and reports errors', () => {
    const root = fresh('cfg');
    const from = path.join(home, 'old', 'app');
    const to = path.join(home, 'new', 'app');
    const f = path.join(root, 'CLAUDE.md');
    writeFileSync(f, `${from}\n${from}-ui\n~/old/app\n`);
    assert.deepEqual(A.rewriteConfigFile(f, from, to), { changed: true });
    assert.equal(readFileSync(f, 'utf8'), `${to}\n${from}-ui\n~/new/app\n`);
    assert.deepEqual(A.rewriteConfigFile(f, from, to), { changed: false });
    assert.ok(A.rewriteConfigFile(path.join(root, 'none'), from, to).error);
  });

  test('spellings: $HOME forms only for paths under home, and only paired like with like', () => {
    const under = path.join(home, 'a');
    assert.ok(A.pathSpellings(under).includes('~/a'));
    assert.ok(A.pathSpellings(under).includes('$HOME/a'));
    const outside = path.resolve('/elsewhere/a');
    assert.ok(!A.pathSpellings(outside).some((s) => s.startsWith('~')));
    const pairs = A.pathSpellingPairs(under, outside);
    assert.ok(pairs.every((p) => !p.from.startsWith('~') && !p.from.startsWith('$')));
    assert.equal(new Set(pairs.map((p) => p.from)).size, pairs.length);
  });

  test('boundary helpers ignore an empty needle', () => {
    assert.equal(A.replaceAtBoundary('abc', '', 'x'), 'abc');
    assert.equal(A.countAtBoundary('abc', ''), 0);
    assert.equal(A.replaceAtBoundary('/a /a-b /a', '/a', '/z'), '/z /a-b /z');
    assert.equal(A.countAtBoundary('/a /a-b /a', '/a'), 2);
  });
});

describe('unfixablePaths', () => {
  test('shell files by line, the history log as a note, and unreadable ones skipped', () => {
    const from = path.join(home, 'src', 'gone');
    writeFileSync(path.join(home, '.zshrc'), `alias g="cd ${from}"\nexport X=1\nalias h="cd ~/src/gone"\n`);
    writeFileSync(path.join(home, '.bashrc'), `alias g="cd $HOME/src/gone"\n`);
    writeFileSync(path.join(home, '.profile'), 'nothing here\n');
    mkdirSync(path.join(home, '.zprofile')); // unreadable as a file
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'history.jsonl'), JSON.stringify({ cwd: from }));

    assert.deepEqual(A.unfixablePaths(from), [
      { what: '~/.zshrc', detail: 'lines 1, 3', why: A.unfixablePaths(from)[0].why, actionable: true },
      { what: '~/.bashrc', detail: 'line 1', why: A.unfixablePaths(from)[1].why, actionable: true },
      { what: '~/.claude/history.jsonl', why: A.unfixablePaths(from)[2].why, actionable: false },
    ]);

    // A history log that cannot be read counts as naming nothing.
    rmSync(path.join(home, '.claude', 'history.jsonl'));
    mkdirSync(path.join(home, '.claude', 'history.jsonl'));
    assert.equal(A.unfixablePaths(from).length, 2);

    for (const f of ['.zshrc', '.bashrc', '.profile', '.zprofile', path.join('.claude', 'history.jsonl')]) {
      rmSync(path.join(home, f), { recursive: true, force: true });
    }
  });
});
