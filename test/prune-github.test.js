// `talea prune` asks GitHub about a clean worktree git calls unmerged: a squash
// merge whose lines main has since edited cannot be seen from git alone. The
// repos are real; the origin URL is made to look like GitHub's and the API is
// swapped through github.js's `io`, so nothing reaches a network.

import assert from 'node:assert/strict';
import test, { after, afterEach, before, beforeEach, describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = home;
const { planRepo, applyRepo, reportAsk, resetAsked } = await import('../src/commands/prune.js');
const { readUserState } = await import('../src/config.js');
const gh = await import('../src/github.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const realSpawn = gh.io.spawnSync;
const realFetch = globalThis.fetch;

let tmp;
before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-prune-gh-')));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

let calls;
let answer;
/** `gh` answers `api` calls with `answer(args)`, and fails `auth token`. */
beforeEach(() => {
  resetAsked();
  rmSync(path.join(home, '.talea'), { recursive: true, force: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  calls = [];
  gh.io.gh = true;
  gh.io.spawnSync = (_cmd, args) => {
    if (args[0] !== 'api') return { status: 1, stdout: '', stderr: 'no token' };
    calls.push(args[1]);
    return answer(args);
  };
});
afterEach(() => {
  gh.io.spawnSync = realSpawn;
  gh.io.gh = null;
  globalThis.fetch = realFetch;
});

const ok = (pulls) => ({ status: 0, stdout: JSON.stringify(pulls), stderr: '' });
const pull = (sha, extra = {}) => ({ merged_at: '2026-01-01T00:00:00Z', base: { ref: 'main' }, head: { sha }, ...extra });

/** A repo on a fake github.com origin, with one worktree git calls unmerged. */
let n = 0;
function makeCase({ origin = true } = {}) {
  const name = `app${n++}`;
  const bare = path.join(tmp, `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', bare], tmp);
  const dir = path.join(tmp, name);
  git(['clone', '-q', bare, dir], tmp);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['checkout', '-q', '-b', 'main'], dir);
  writeFileSync(path.join(dir, 'a'), 'a\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'a'], dir);
  git(['push', '-q', 'origin', 'main'], dir);
  const wt = path.join(`${dir}-worktrees`, 'feat');
  git(['worktree', 'add', '-q', '-b', 'feat', wt], dir);
  writeFileSync(path.join(wt, 'f'), 'f\n');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'f'], wt);
  git(['config', 'remote.origin.url', origin ? `https://github.com/me/${name}.git` : bare], dir);
  if (!origin) git(['config', '--unset', 'remote.origin.url'], dir);
  return { name, dir, wt, head: git(['rev-parse', 'HEAD'], wt), entry: { repo: { name, owner: 'me', defaultBranch: 'main' }, dir } };
}
/** A second worktree of the same repo, one commit of its own. */
function addSecond(c) {
  const wt = path.join(`${c.dir}-worktrees`, 'feat2');
  git(['worktree', 'add', '-q', '-b', 'feat2', wt], c.dir);
  writeFileSync(path.join(wt, 'g'), 'g\n');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'g'], wt);
  return git(['rev-parse', 'HEAD'], wt);
}
const fail = (status, text = 'boom') => ({ status: 1, stdout: '', stderr: `gh: ${text} (HTTP ${status})` });
const stderrOf = async (fn) => {
  const err = [];
  const { error } = console;
  console.error = (...x) => err.push(x.join(' '));
  try {
    await fn();
  } finally {
    console.error = error;
  }
  return err;
};
const OPTS = { fetch: false, removableOnly: true };
const verdict = async (c, opts = OPTS) => (await planRepo(c.entry, opts)).worktrees[0].verdict;

describe('a worktree git calls unmerged, asked of GitHub', () => {
  test('a merged PR whose head is the worktree head reads as merged; the cache then answers alone', async () => {
    const c = makeCase();
    answer = () => ok([pull('0'.repeat(40)), pull(c.head)]);
    assert.equal(await verdict(c), 'merged');
    assert.match(calls[0], new RegExp(`^/repos/me/${c.name}/commits/${c.head}/pulls`));
    assert.equal(readUserState().mergedHeads[`me/${c.name}@${c.head}`], true);

    resetAsked();
    calls = [];
    assert.equal(await verdict(c), 'merged');
    assert.deepEqual(calls, []);
  });

  test('a PR head above the worktree HEAD (main merged in) reads as merged; one not present locally does not', async () => {
    const c = makeCase();
    git(['commit', '-q', '--allow-empty', '-m', 'merge main'], c.wt);
    const above = git(['rev-parse', 'HEAD'], c.wt);
    git(['reset', '-q', '--hard', c.head], c.wt);
    answer = () => ok([pull(above)]);
    assert.equal(await verdict(c), 'merged');

    const d = makeCase();
    answer = () => ok([pull('1'.repeat(40))]); // a commit this clone never fetched
    assert.equal(await verdict(d), 'unmerged');
    assert.equal(readUserState().mergedHeads[`me/${c.name}@${c.head}`], true);
    assert.equal(readUserState().mergedHeads[`me/${d.name}@${d.head}`], undefined);
  });

  test('sync and prune get the same verdict, and the same sha is asked once per run', async () => {
    const c = makeCase();
    answer = () => ok([pull(c.head)]);
    const plan = await planRepo(c.entry, OPTS);
    assert.equal(plan.worktrees[0].verdict, 'merged');
    assert.equal(await verdict(c, { fetch: false }), 'merged'); // the prune options
    await applyRepo(c.dir, plan); // the rejudge before removal asks the run's memory
    assert.equal(calls.length, 1);
  });

  for (const [why, p] of [
    ['a head that is not a descendant', () => pull('0'.repeat(40))],
    ['another base branch', (head) => pull(head, { base: { ref: 'develop' } })],
    ['no merged_at', (head) => pull(head, { merged_at: null })],
  ]) {
    test(`${why} stays unmerged and is not cached`, async () => {
      const c = makeCase();
      answer = () => ok([p(c.head)]);
      assert.equal(await verdict(c), 'unmerged');
      assert.equal(readUserState().mergedHeads, undefined);
    });
  }

  test('an API failure stays unmerged, says so once on stderr, and stops asking', async () => {
    const a = makeCase();
    const b = makeCase();
    answer = () => fail(403, 'API rate limit exceeded');
    assert.equal(await verdict(a), 'unmerged');
    assert.equal(await verdict(b), 'unmerged');
    assert.equal(calls.length, 1);
    const err = [];
    const { error } = console;
    console.error = (...x) => err.push(x.join(' '));
    try {
      reportAsk();
      reportAsk();
    } finally {
      console.error = error;
    }
    assert.equal(err.length, 1);
    assert.match(err[0], /could not ask GitHub \(GitHub — gh: API rate limit exceeded \(HTTP 403\)\) — worktrees judged from git alone/);
  });

  test('unparsable JSON is unknown, so unmerged', async () => {
    const c = makeCase();
    answer = () => ({ status: 0, stdout: 'not json', stderr: '' });
    assert.equal(await verdict(c), 'unmerged');
  });

  test('through fetch, with a token from the environment', async () => {
    const c = makeCase();
    process.env.GITHUB_TOKEN = 'tok';
    gh.io.gh = false;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push([url, init.headers.authorization]);
      return new Response(JSON.stringify([pull(c.head)]), { status: 200 });
    };
    assert.equal(await verdict(c), 'merged');
    assert.deepEqual(seen, [[`https://api.github.com/repos/me/${c.name}/commits/${c.head}/pulls?per_page=100`, 'Bearer tok']]);
  });

  test('a remote that is not GitHub, or no origin at all, is never asked about', async () => {
    answer = () => ok([]);
    const local = makeCase();
    git(['config', 'remote.origin.url', local.dir], local.dir);
    assert.equal(await verdict(local), 'unmerged');
    const none = makeCase({ origin: false });
    assert.equal(await verdict(none), 'unmerged');
    assert.deepEqual(calls, []);
    reportAsk(); // nothing went wrong, so nothing is said
  });

  test('422 (a commit never pushed) is unmerged for that worktree only — the next is still asked, and nothing is said', async () => {
    const c = makeCase();
    const second = addSecond(c);
    answer = (args) => (args[1].includes(c.head) ? fail(422, 'No commit found for SHA') : ok([pull(second)]));
    const plan = await planRepo(c.entry, OPTS);
    const by = Object.fromEntries(plan.worktrees.map((w) => [path.basename(w.path), w.verdict]));
    assert.deepEqual(by, { feat: 'unmerged', feat2: 'merged' });
    assert.equal(calls.length, 2);
    assert.deepEqual(await stderrOf(reportAsk), []);
  });

  test('404 stops that repo only, with one note; another repo is still asked', async () => {
    const a = makeCase();
    addSecond(a);
    const b = makeCase();
    answer = (args) => (args[1].includes(`/${a.name}/`) ? fail(404, 'Not Found') : ok([pull(b.head)]));
    const plan = await planRepo(a.entry, OPTS);
    assert.deepEqual(plan.worktrees.map((w) => w.verdict), ['unmerged', 'unmerged']);
    assert.equal(calls.length, 1);
    assert.equal(await verdict(b), 'merged');
    const err = await stderrOf(reportAsk);
    assert.equal(err.length, 1);
    assert.match(err[0], /Not Found/);
  });

  test('429 stops every repo and says so once', async () => {
    const a = makeCase();
    const b = makeCase();
    answer = () => fail(429, 'too many');
    assert.equal(await verdict(a), 'unmerged');
    assert.equal(await verdict(b), 'unmerged');
    assert.equal(calls.length, 1);
    assert.equal((await stderrOf(reportAsk)).length, 1);
  });

  test('only a github.com remote is asked about, in every spelling it has', async () => {
    answer = () => ok([]);
    const good = ['https://github.com/me/x.git', 'https://user@github.com/me/x.git', 'git@github.com:me/x.git', 'ssh://git@github.com/me/x.git', 'HTTP://GitHub.com/me/x'];
    const bad = ['https://notgithub.com/me/x.git', 'git@notgithub.com:me/x.git', 'https://github.com.evil.example/me/x', 'https://evil.example/github.com/me/x', '/srv/github.com/x.git'];
    for (const [urls, asks] of [[good, 1], [bad, 0]]) {
      for (const url of urls) {
        resetAsked();
        calls = [];
        const c = makeCase();
        git(['config', 'remote.origin.url', url], c.dir);
        await verdict(c);
        assert.equal(calls.length, asks, url);
      }
    }
  });

  test('--apply never turns an unmerged plan into a removal, and honours a cached yes', async () => {
    const c = makeCase();
    answer = () => ok([]);
    const plan = await planRepo(c.entry, OPTS);
    assert.equal(plan.worktrees[0].verdict, 'unmerged');
    answer = () => ok([pull(c.head)]); // GitHub changes its mind after the plan
    await applyRepo(c.dir, plan);
    assert.equal(plan.worktrees[0].verdict, 'unmerged');
    assert.equal(existsSync(c.wt), true);

    const d = makeCase();
    answer = () => ok([pull(d.head)]);
    const yes = await planRepo(d.entry, OPTS);
    resetAsked();
    answer = () => ok([]); // a fresh run, and GitHub now says no: the cached yes stands
    await applyRepo(d.dir, yes);
    assert.equal(yes.worktrees[0].verdict, 'removed');
    assert.equal(existsSync(d.wt), false);
  });
});
