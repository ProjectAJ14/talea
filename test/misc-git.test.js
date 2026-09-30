// src/git.js against real git in scratch folders, plus the ref-lock healing
// driven by a scripted runner — a case collision between two remote branches
// only happens on a case-insensitive filesystem, and CI runs on Linux too.

import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
const G = await import('../src/git.js');

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-git-')));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const sh = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let n = 0;
function makeRepo() {
  const name = `r${n++}`;
  const origin = path.join(tmp, `${name}.git`);
  sh(['init', '-q', '--bare', '-b', 'main', origin], tmp);
  const dir = path.join(tmp, name);
  sh(['clone', '-q', origin, dir], tmp);
  sh(['config', 'user.email', 't@example.com'], dir);
  sh(['config', 'user.name', 't'], dir);
  sh(['checkout', '-q', '-b', 'main'], dir);
  return { dir, origin };
}
const commit = (dir, file) => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  sh(['add', '-A'], dir);
  sh(['commit', '-qm', file], dir);
};

describe('git()', () => {
  test('a spawn failure resolves with code -1 rather than throwing', async () => {
    const res = await G.git(['--version'], { cwd: path.join(tmp, 'nowhere') });
    assert.equal(res.code, -1);
    assert.ok(res.stderr);
  });

  test('stdin is fed when input is given', async () => {
    const { dir } = makeRepo();
    const res = await G.git(['hash-object', '--stdin'], { cwd: dir, input: 'x\n' });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /^[0-9a-f]{40}/);
  });

  test('a git that exits without reading stdin is not an unhandled EPIPE', async () => {
    const res = await G.git(['--version'], { input: 'x'.repeat(8 * 1024 * 1024) });
    assert.equal(res.code, 0);
  });

  test('cleanGitEnv clears the variables that redirect git', () => {
    const env = G.cleanGitEnv({ GIT_DIR: '/x', KEEP: '1' });
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.KEEP, '1');
  });

  test('gitVersion is null when git is not on PATH', async () => {
    assert.match(await G.gitVersion(), /^\d/);
    const saved = process.env.PATH;
    process.env.PATH = path.join(tmp, 'empty-bin');
    try {
      assert.equal(await G.gitVersion(), null);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('repo queries', () => {
  test('branch, dirty, upstream, ahead/behind, and branch existence', async () => {
    const { dir } = makeRepo();
    // An unborn branch: rev-parse fails, symbolic-ref still knows the name.
    assert.equal(await G.currentBranch(dir), 'main');
    assert.equal(await G.currentBranch(path.join(tmp, 'not-a-repo')), null);
    assert.equal(G.isRepo(dir), true);
    assert.equal(G.isRepo(tmp), false);

    commit(dir, 'a.txt');
    sh(['push', '-q', '-u', 'origin', 'main'], dir);
    assert.equal(await G.currentBranch(dir), 'main');
    assert.equal(await G.isDirty(dir), false);
    writeFileSync(path.join(dir, 'new.txt'), 'x\n');
    assert.equal(await G.isDirty(dir), true);
    rmSync(path.join(dir, 'new.txt'));

    assert.equal(await G.hasUpstream(dir), true);
    commit(dir, 'b.txt');
    assert.deepEqual(await G.aheadBehind(dir), { ahead: 1, behind: 0 });
    sh(['checkout', '-q', '-b', 'loose'], dir);
    assert.equal(await G.hasUpstream(dir), false);
    assert.equal(await G.aheadBehind(dir), null);

    assert.equal(await G.localHasBranch(dir, 'loose'), true);
    assert.equal(await G.localHasBranch(dir, 'nope'), false);
    assert.equal(await G.remoteHasBranch(dir, 'main'), true);
    assert.equal(await G.remoteHasBranch(dir, 'loose'), false);
  });

  test('isMissingRemote reads the three wordings of "not there"', () => {
    assert.equal(G.isMissingRemote('ERROR: Repository not found.'), true);
    assert.equal(G.isMissingRemote('TF401019: gone'), true);
    assert.equal(G.isMissingRemote('does not exist or you do not have permission'), true);
    assert.equal(G.isMissingRemote('Connection timed out'), false);
  });
});

describe('fetch, checkout, merge, stash, clone', () => {
  test('the round trip against a local bare origin', async () => {
    const { dir, origin } = makeRepo();
    commit(dir, 'a.txt');
    sh(['push', '-q', '-u', 'origin', 'main'], dir);
    sh(['push', '-q', 'origin', 'main:feature'], dir);

    const other = path.join(tmp, 'other');
    assert.equal((await G.clone(origin, other, 'main')).code, 0);
    sh(['config', 'user.email', 't@example.com'], other);
    sh(['config', 'user.name', 't'], other);
    commit(other, 'b.txt');
    sh(['push', '-q', 'origin', 'main'], other);
    assert.equal((await G.clone(origin, path.join(tmp, 'other2'))).code, 0);

    assert.equal((await G.fetch(dir)).code, 0);
    assert.equal((await G.ffMerge(dir)).code, 0);
    assert.equal(existsSync(path.join(dir, 'b.txt')), true);

    // First use creates the branch from origin; the second finds it local.
    assert.equal((await G.checkout(dir, 'feature')).code, 0);
    assert.equal(await G.currentBranch(dir), 'feature');
    assert.equal((await G.checkout(dir, 'main')).code, 0);
    assert.equal((await G.checkout(dir, 'feature')).code, 0);

    writeFileSync(path.join(dir, 'wip.txt'), 'wip\n');
    assert.equal((await G.stashPush(dir, 'talea test')).code, 0);
    assert.equal(await G.isDirty(dir), false);
    assert.match(sh(['stash', 'list'], dir), /talea test/);
  });

  test('a stale ref lock left by a killed fetch is cleared and the fetch retried', async () => {
    const { dir } = makeRepo();
    commit(dir, 'a.txt');
    sh(['push', '-q', '-u', 'origin', 'main'], dir);
    // Move origin on, so the next fetch has to lock the ref to update it.
    sh(['push', '-q', 'origin', 'main:side'], dir);
    sh(['update-ref', '-d', 'refs/remotes/origin/side'], dir); // push cached it; forget that
    const lock = path.join(dir, '.git', 'refs', 'remotes', 'origin', 'side.lock');
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);

    const res = await G.fetch(dir);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(existsSync(lock), false);
  });
});

describe('unlocking, scripted', () => {
  // A runner that replays `results` in order and records every call.
  const script = (results) => {
    const calls = [];
    const run = async (args, opts) => {
      calls.push(args);
      return results.length > 1 ? results.shift() : results[0];
    };
    return { run, calls };
  };
  const ok = { code: 0, stdout: '', stderr: '' };
  const collide = (dir) => ({
    code: 1,
    stdout: '',
    stderr: `error: cannot lock ref 'refs/remotes/origin/Foo': Unable to create '${path.join(dir, 'Foo.lock')}': File exists.`,
  });

  test('a case collision drops the remote ref git named and retries', async () => {
    const dir = path.join(tmp, 'collide');
    const { run, calls } = script([collide(dir), ok, ok, ok]);
    const res = await G.unlocking(['fetch'], { cwd: dir }, run);
    assert.equal(res.code, 0);
    assert.deepEqual(calls.map((a) => a[0]), ['fetch', 'show-ref', 'update-ref', 'fetch']);
  });

  test('a ref already gone, or one that will not delete, is not progress', async () => {
    const dir = path.join(tmp, 'collide');
    const gone = script([collide(dir), { code: 1 }]);
    assert.equal((await G.unlocking(['fetch'], { cwd: dir }, gone.run)).code, 1);
    assert.deepEqual(gone.calls.map((a) => a[0]), ['fetch', 'show-ref']);

    const stuck = script([collide(dir), ok, { code: 1 }]);
    assert.equal((await G.unlocking(['fetch'], undefined, stuck.run)).code, 1);
    assert.deepEqual(stuck.calls.map((a) => a[0]), ['fetch', 'show-ref', 'update-ref']);
  });

  test('a lock a live git still holds is never removed or worked around', async () => {
    const dir = path.join(tmp, 'live-lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Foo.lock'), '');
    const { run, calls } = script([collide(dir)]);
    assert.equal((await G.unlocking(['fetch'], { cwd: dir }, run)).code, 1);
    assert.equal(existsSync(path.join(dir, 'Foo.lock')), true);
    assert.deepEqual(calls.map((a) => a[0]), ['fetch']);
  });

  test('healing stops after ten rounds even if every round claims progress', async () => {
    const dir = path.join(tmp, 'endless');
    const failing = collide(dir);
    let i = 0;
    const run = async (args) => (args[0] === 'fetch' ? (i++, failing) : ok);
    assert.equal((await G.unlocking(['fetch'], { cwd: dir }, run)).code, 1);
    assert.equal(i, 11);
  });

  test('a relative lock path resolves against the process cwd when none is given', async () => {
    const { run, calls } = script([{ code: 1, stderr: "Unable to create 'no-such.lock': File exists." }]);
    assert.equal((await G.unlocking(['fetch'], {}, run)).code, 1);
    assert.equal(calls.length, 1);
  });
});

describe('the pool', () => {
  test('defaultJobs sits between 6 and 12', () => {
    const j = G.defaultJobs();
    assert.ok(j >= 6 && j <= 12);
  });

  test('pooled keeps order and never exceeds the limit', async () => {
    let live = 0;
    let peak = 0;
    const out = await G.pooled([1, 2, 3, 4, 5], 2, async (x, i) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return x * 10 + i;
    });
    assert.deepEqual(out, [10, 21, 32, 43, 54]);
    assert.equal(peak, 2);
    assert.deepEqual(await G.pooled([], 4, async () => 1), []);
  });
});
