// `talea prune` paths the verdict tests in prune.test.js do not reach: repos
// that cannot be judged, removals git refuses, the report's every line, and
// the helpers' edge cases. Real git, local bare origins, nothing on a network.

import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach, describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// run() records the workspace under ~/.talea; config.js reads home on load.
// .native: Windows TEMP is an 8.3 short name, git prints the long one, and the
// `~/` in the report is a prefix match between the two.
const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'talea-home-')));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
const { applyRepo, formatBytes, measure, planRepo, run, userIgnored } = await import('../src/commands/prune.js');
const { canonical } = await import('../src/adopt.js');

const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'talea-prune-misc-')));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, file) => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-qm', file], dir);
};

/** A clone of a bare origin on `main` with one commit; `ignore` becomes its .gitignore. */
function makeRepo(dir, ignore) {
  const origin = `${dir}.git`;
  mkdirSync(path.dirname(dir), { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', origin], tmp);
  git(['clone', '-q', origin, dir], tmp);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['checkout', '-q', '-b', 'main'], dir);
  if (ignore) writeFileSync(path.join(dir, '.gitignore'), ignore);
  commit(dir, 'README.md');
  git(['push', '-q', 'origin', 'main'], dir);
  return dir;
}
function addWorktree(dir, branch, where = path.join(`${dir}-worktrees`, branch), from = 'HEAD') {
  git(['worktree', 'add', '-q', '-b', branch, where, from], dir);
  commit(where, `${branch}.txt`);
  return where;
}
const entry = (dir, extra = {}) => ({
  repo: { name: path.basename(dir), owner: 'me', defaultBranch: 'main', ...extra },
  dir,
});
const find = (plan, wt) => plan.worktrees.find((w) => canonical(w.path) === canonical(wt));

/**
 * A `git` first on PATH that fails `$FAKE_FAIL` silently and runs the real one
 * for everything else — the only way to make git fail with an empty stderr.
 * A shell script, so POSIX only: Windows spawn will not run one without a shell.
 */
const posix = process.platform !== 'win32';
function withFakeGit(fails, fn) {
  const bin = path.join(tmp, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const fake = path.join(bin, 'git');
  writeFileSync(fake, `#!/bin/sh\ncase "$1 $2" in "$FAKE_FAIL"*) exit 1 ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(fake, 0o755);
  const saved = { PATH: process.env.PATH, FAKE_FAIL: process.env.FAKE_FAIL };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  process.env.FAKE_FAIL = fails;
  return Promise.resolve(fn()).finally(() => {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_FAIL === undefined) delete process.env.FAKE_FAIL;
    else process.env.FAKE_FAIL = saved.FAKE_FAIL;
  });
}

describe('helpers', () => {
  test('formatBytes keeps bytes whole and gives one decimal above', () => {
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 ** 5 * 2), '2048.0 TB');
  });

  test('measure: a path that is gone is empty, and an unreadable folder counts only itself', async () => {
    assert.deepEqual(await measure(path.join(tmp, 'gone')), { size: 0, nested: [] });

    const root = path.join(tmp, 'measured');
    const locked = path.join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(path.join(locked, 'f.txt'), 'x'.repeat(10_000));
    chmodSync(locked, 0o000); // no effect on Windows, nor for root — still a valid run
    try {
      const { size, nested } = await measure(root);
      assert.ok(size > 0);
      assert.deepEqual(nested, []);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('userIgnored: a folder past 200 files is named whole, and a bad base still reads the worktree', async () => {
    const dir = makeRepo(path.join(tmp, 'big'), 'gen/\n');
    const gen = path.join(dir, 'gen');
    mkdirSync(gen);
    for (let i = 0; i < 201; i++) writeFileSync(path.join(gen, `${i}.txt`), `${i}`);
    assert.deepEqual(await userIgnored(dir, path.join(tmp, 'elsewhere'), 'no-such-ref'), ['gen/']);
  });
});

describe('planRepo and applyRepo when git says no', () => {
  test('a folder that is not a repo fails to list', async () => {
    const dir = path.join(tmp, 'plain');
    mkdirSync(dir, { recursive: true });
    assert.match((await planRepo(entry(dir))).fail, /git worktree list failed/);
  });

  test('no linked worktrees: nothing to fetch, nothing to say', async () => {
    const dir = makeRepo(path.join(tmp, 'solo'));
    assert.deepEqual(await planRepo(entry(dir)), { base: null, worktrees: [] });
  });

  test('a failed fetch fails the repo, and a missing default branch skips it', async () => {
    const dir = makeRepo(path.join(tmp, 'nofetch'));
    addWorktree(dir, 'feat');
    assert.match((await planRepo(entry(dir, { defaultBranch: 'develop' }))).skip, /origin\/develop does not exist/);
    git(['remote', 'set-url', 'origin', path.join(tmp, 'no-such-origin.git')], dir);
    assert.match((await planRepo(entry(dir))).fail, /^fetch failed: \S/);
  });

  test('removals and the record prune that git refuses are reported, not hidden', async () => {
    const dir = path.join(tmp, 'plain');
    mkdirSync(dir, { recursive: true });
    const plan = {
      worktrees: [
        { path: path.join(tmp, 'a'), verdict: 'merged', lossy: [] },
        { path: path.join(tmp, 'b'), verdict: 'missing', lossy: [] },
        { path: path.join(tmp, 'c'), verdict: 'unmerged', lossy: [] },
      ],
    };
    await applyRepo(dir, plan);
    assert.deepEqual(plan.worktrees.map((w) => w.verdict), ['failed', 'failed', 'unmerged']);
    assert.match(plan.worktrees[0].error, /not a git repository/);
    assert.match(plan.worktrees[1].error, /not a git repository/);
  });

  test('a git that fails with nothing on stderr still gets a reason', { skip: !posix && 'needs a shell-script git' }, async () => {
    const dir = makeRepo(path.join(tmp, 'silent'));
    const merged = addWorktree(dir, 'feat');
    const gone = addWorktree(dir, 'gone');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    rmSync(gone, { recursive: true, force: true });

    const plan = await planRepo(entry(dir));
    await withFakeGit('worktree', () => applyRepo(dir, plan));
    assert.equal(find(plan, merged).error, 'git refused');
    assert.equal(find(plan, gone).error, 'git worktree prune failed');

    await withFakeGit('fetch', async () => {
      assert.equal((await planRepo(entry(dir))).fail, 'fetch failed: unknown error');
    });
  });
});

describe('talea prune, the report', () => {
  let out;
  const saved = {};
  beforeEach(() => {
    out = [];
    Object.assign(saved, { log: console.log, error: console.error, cwd: process.cwd() });
    console.log = console.error = (s = '') => out.push(String(s));
  });
  afterEach(() => {
    console.log = saved.log;
    console.error = saved.error;
    process.chdir(saved.cwd);
    process.exitCode = undefined;
  });
  const text = () => out.join('\n');

  /** A workspace inside home, so the dim path line reads `~/…`. */
  function workspace(name, repos, selected = repos.map((r) => r.name)) {
    const ws = path.join(home, name);
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'talea.repos.json'), JSON.stringify({ repos }));
    writeFileSync(path.join(ws, '.talea.json'), JSON.stringify({ selected }));
    return ws;
  }

  test('with no linked worktrees it says so', async () => {
    const ws = workspace('ws-empty', [{ name: 'lone', owner: 'me', defaultBranch: 'main' }]);
    makeRepo(path.join(ws, 'me', 'lone'));
    process.chdir(ws);
    await run({ jobs: 2 });
    assert.match(text(), /No linked worktrees/);
    assert.equal(process.exitCode ?? 0, 0);
  });

  test('dry run, apply, and a second look: every kind of line', async () => {
    const ws = workspace('ws-full', [
      { name: 'keep', owner: 'me', defaultBranch: 'main' },
      { name: 'nodef', owner: 'me' },
      { name: 'broken', owner: 'me', defaultBranch: 'main' },
      { name: 'mixed', owner: 'me', defaultBranch: 'main' },
      { name: 'other', owner: 'me', defaultBranch: 'main' }, // not selected: only --all reaches it
      { name: 'theirs', owner: 'me', defaultBranch: 'main', ignore: true },
    ], ['keep', 'nodef', 'broken', 'mixed']);

    const keep = makeRepo(path.join(ws, 'me', 'keep'), '.env\nnotes/\n');
    const one = addWorktree(keep, 'one');
    const many = addWorktree(keep, 'many', undefined, 'one');
    git(['push', '-q', 'origin', 'many:main'], keep);
    writeFileSync(path.join(one, '.env'), 'SECRET=1\n');
    mkdirSync(path.join(many, 'notes'));
    for (const f of ['a', 'b', 'c', 'd']) writeFileSync(path.join(many, 'notes', `${f}.md`), f);

    addWorktree(makeRepo(path.join(ws, 'me', 'nodef')), 'feat');
    const broken = makeRepo(path.join(ws, 'me', 'broken'));
    addWorktree(broken, 'feat');
    git(['remote', 'set-url', 'origin', path.join(tmp, 'vanished.git')], broken);

    const mixed = makeRepo(path.join(ws, 'me', 'mixed'));
    const detached = path.join(tmp, 'far', 'detached'); // outside home: printed as is
    git(['worktree', 'add', '-q', '--detach', detached], mixed);
    commit(detached, 'wip.txt');
    rmSync(addWorktree(mixed, 'gone'), { recursive: true, force: true });
    const done = addWorktree(mixed, 'done');
    git(['push', '-q', 'origin', 'done:main'], mixed);

    const other = makeRepo(path.join(ws, 'me', 'other'));
    addWorktree(other, 'feat');

    process.chdir(ws);
    await run({});
    let t = text();
    assert.match(t, /dry run/);
    assert.match(t, /nodef — no default branch recorded/);
    assert.match(t, /broken — fetch failed/);
    assert.match(t, /keep\/one is merged, kept for ignored file: \.env — move it, or --with-ignored/);
    assert.match(t, /keep\/many is merged, kept for ignored files: notes\/a\.md, notes\/b\.md, notes\/c\.md.* and 1 more.* — move them/);
    assert.match(t, /\(detached\)/);
    assert.match(t, /~\/ws-full\/me\/keep-worktrees\/one/);
    assert.match(t, /far[\\/]detached/);
    assert.doesNotMatch(t, /~\S*far[\\/]detached/);
    assert.match(t, /would free/);
    assert.doesNotMatch(t, /other/);
    assert.equal(process.exitCode, 1, 'a failed repo must fail the run');
    assert.equal(existsSync(done), true);

    process.exitCode = undefined;
    out = [];
    await run({ apply: true, 'with-ignored': true });
    t = text();
    assert.match(t, /Pruning worktrees/);
    assert.match(t, /keep\/one lost ignored file: \.env/);
    assert.match(t, /freed/);
    assert.match(t, /cleared/);
    assert.equal(existsSync(done), false);
    assert.equal(existsSync(one), false);

    // Nothing left to remove: the tally, and no "would free" line. --all
    // reaches `other`, and still never the ignored `theirs`.
    process.exitCode = undefined;
    out = [];
    git(['remote', 'set-url', 'origin', `${broken}.git`], broken);
    await run({ all: true });
    t = text();
    assert.match(t, /other/);
    assert.doesNotMatch(t, /theirs/);
    assert.doesNotMatch(t, /would free/);
    assert.match(t, /unmerged/);
  });

  test('a removal git refuses is named, and its ignored files are not called lost', { skip: !posix && 'needs a shell-script git' }, async () => {
    const ws = workspace('ws-refused', [{ name: 'app', owner: 'me', defaultBranch: 'main' }]);
    const dir = makeRepo(path.join(ws, 'me', 'app'), '.env\n');
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
    process.chdir(ws);

    await withFakeGit('worktree remove', () => run({ apply: true, 'with-ignored': true }));
    assert.match(text(), /app\/feat — git refused/);
    assert.doesNotMatch(text(), /lost ignored/);
    assert.equal(process.exitCode, 1);
    assert.equal(existsSync(path.join(wt, '.env')), true);
  });
});
