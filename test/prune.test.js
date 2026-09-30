// `talea prune` — the one command that deletes, so every verdict is pinned
// against real git. The origin is a local bare repo: nothing reaches a network.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `run()` records the workspace in ~/.talea/state.json; keep that out of the
// developer's own list. Set before the import: config.js reads home on load.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = home;
const { planRepo, applyRepo, lossyIgnored, run } = await import('../src/commands/prune.js');
const { canonical } = await import('../src/adopt.js');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
before(() => {
  // Real path: macOS's tmpdir is a symlink, and git reports worktrees resolved.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-prune-')));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const commit = (dir, file, text = file) => {
  writeFileSync(path.join(dir, file), `${text}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-qm', file], dir);
};

/** A clone of a bare origin, on `main`, with one commit. */
function makeRepo(name, parent = tmp) {
  const origin = path.join(tmp, `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', origin], tmp);
  const dir = path.join(parent, name);
  git(['clone', '-q', origin, dir], tmp);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['checkout', '-q', '-b', 'main'], dir);
  commit(dir, 'README.md');
  git(['push', '-q', 'origin', 'main'], dir);
  return dir;
}

/** A worktree on a new branch with one commit of its own. */
function addWorktree(dir, branch, where = path.join(`${dir}-worktrees`, branch)) {
  git(['worktree', 'add', '-q', '-b', branch, where], dir);
  commit(where, `${branch}.txt`);
  return where;
}

const repo = (dir, extra = {}) => ({
  repo: { name: path.basename(dir), owner: 'me', defaultBranch: 'main', ...extra },
  dir,
});
// git prints `C:/Users/runneradmin/...` where Node has `C:\Users\RUNNER~1\...`,
// so compare canonical forms or every lookup misses on Windows.
const entryOf = (plan, wt) => plan.worktrees.find((w) => canonical(w.path) === canonical(wt));
const verdictOf = (plan, wt) => entryOf(plan, wt)?.verdict;

describe('prune judges each worktree', () => {
  test('merged + clean is removed on --apply, and a dry run removes nothing', async () => {
    const dir = makeRepo('merged');
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir); // merged by fast-forward

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'merged');
    assert.ok(plan.worktrees[0].size > 0, 'size was not measured');
    assert.equal(existsSync(wt), true, 'the plan removed something');

    await applyRepo(dir, plan);
    assert.equal(verdictOf(plan, wt), 'removed');
    assert.equal(existsSync(wt), false);
    // The branch stays: only the folder goes.
    assert.equal(git(['branch', '--list', 'feat'], dir).replace(/^[*+ ]+/, ''), 'feat');
  });

  test('a rebase merge (patch-identical commits) reads as merged', async () => {
    const dir = makeRepo('rebased');
    const wt = addWorktree(dir, 'feat');
    commit(dir, 'other.txt'); // main moved on, so the cherry-pick gets a new sha
    git(['cherry-pick', 'feat'], dir);
    git(['push', '-q', 'origin', 'main'], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'merged');
  });

  test('an unmerged commit is kept', async () => {
    const dir = makeRepo('unmerged');
    const wt = addWorktree(dir, 'feat');
    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'unmerged');
    await applyRepo(dir, plan);
    assert.equal(existsSync(wt), true);
  });

  test('a modified file and an untracked file both keep it', async () => {
    const dir = makeRepo('dirty');
    const modified = addWorktree(dir, 'a');
    const untracked = addWorktree(dir, 'b');
    git(['push', '-q', 'origin', 'a:main'], dir);
    git(['merge', '-q', '--ff-only', 'origin/main'], dir);
    writeFileSync(path.join(modified, 'README.md'), 'changed\n');
    writeFileSync(path.join(untracked, 'NOTES.txt'), 'mine\n');
    git(['-C', untracked, 'reset', '-q', '--hard', 'origin/main'], dir); // b is now merged too

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, modified), 'dirty');
    assert.equal(verdictOf(plan, untracked), 'dirty');
    await applyRepo(dir, plan);
    assert.equal(existsSync(modified) && existsSync(untracked), true);
  });

  test('a merged worktree with another worktree inside it is kept', async () => {
    // git calls the outer one clean when the inner sits under an ignored path,
    // and `git worktree remove` would delete the inner one's uncommitted work.
    const dir = makeRepo('nested');
    writeFileSync(path.join(dir, '.gitignore'), '.claude/\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const outer = addWorktree(dir, 'outer');
    git(['push', '-q', 'origin', 'outer:main'], dir);
    const inner = path.join(outer, '.claude', 'worktrees', 'inner');
    git(['worktree', 'add', '-q', '-b', 'inner', inner], dir);
    writeFileSync(path.join(inner, 'WIP.txt'), 'unsaved\n');

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, outer), 'nested');
    await applyRepo(dir, plan);
    assert.equal(existsSync(path.join(inner, 'WIP.txt')), true, 'nested work was deleted');
  });

  test('a locked worktree is kept, even when merged', async () => {
    const dir = makeRepo('locked');
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    git(['worktree', 'lock', wt], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'locked');
    await applyRepo(dir, plan);
    assert.equal(existsSync(wt), true);
  });

  test('a worktree deleted by hand is cleared from the record', async () => {
    const dir = makeRepo('missing');
    const wt = addWorktree(dir, 'feat');
    rmSync(wt, { recursive: true, force: true });

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'missing');
    await applyRepo(dir, plan);
    assert.equal(verdictOf(plan, wt), 'cleared');
    assert.doesNotMatch(git(['worktree', 'list', '--porcelain'], dir), /feat/);
  });

  test('a repo with no default branch recorded is skipped, never judged against main', async () => {
    const dir = makeRepo('nodefault');
    addWorktree(dir, 'feat');
    const plan = await planRepo(repo(dir, { defaultBranch: undefined }));
    assert.match(plan.skip, /no default branch/);
    assert.equal(plan.worktrees, undefined);
  });

  test('a worktree outside the workspace is found and handled', async () => {
    const dir = makeRepo('faraway');
    const far = addWorktree(dir, 'feat', path.join(tmp, 'somewhere', 'else', 'feat'));
    git(['push', '-q', 'origin', 'feat:main'], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, far), 'merged');
    await applyRepo(dir, plan);
    assert.equal(existsSync(far), false);
  });

  test('an ignored file that is not build output keeps it, unless --with-ignored', async () => {
    const dir = makeRepo('ignored');
    writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\n.plan/\n');
    commit(dir, 'keep.txt'); // takes the .gitignore with it
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
    mkdirSync(path.join(wt, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(wt, 'node_modules', 'x', 'i.js'), '1\n');

    // `--apply` plans and removes in one run, so naming the .env is not
    // enough: without --with-ignored the worktree is kept.
    const plan = await planRepo(repo(dir));
    const entry = entryOf(plan, wt);
    assert.equal(entry.verdict, 'ignored');
    assert.deepEqual(entry.lossy, ['.env']);
    await applyRepo(dir, plan);
    assert.equal(existsSync(path.join(wt, '.env')), true, 'the .env was deleted');

    const opted = await planRepo(repo(dir), { withIgnored: true });
    assert.equal(verdictOf(opted, wt), 'merged');
    await applyRepo(dir, opted);
    assert.equal(existsSync(wt), false);
  });

  test('untracked files keep it even when status.showUntrackedFiles=no hides them', async () => {
    // git worktree remove honours that setting too, so it would delete them.
    const dir = makeRepo('hidden');
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    git(['config', 'status.showUntrackedFiles', 'no'], dir);
    writeFileSync(path.join(wt, 'NOTES.txt'), 'mine\n');

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'dirty');
    await applyRepo(dir, plan);
    assert.equal(existsSync(path.join(wt, 'NOTES.txt')), true, 'untracked work was deleted');
  });

  test('a worktree whose branch has no commits yet is kept as fresh', async () => {
    const dir = makeRepo('fresh');
    const wt = path.join(`${dir}-worktrees`, 'new-task');
    git(['worktree', 'add', '-q', '-b', 'new-task', wt], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'fresh');
    await applyRepo(dir, plan);
    assert.equal(existsSync(wt), true);
  });
});

describe('lossyIgnored', () => {
  test('drops build output at any depth, keeps anything else', () => {
    const listing = 'node_modules/\npackages/a/dist/\n.dart_tool/\n.env\n.plan/\n.claude/settings.local.json\n';
    assert.deepEqual(lossyIgnored(listing), ['.env', '.plan/']);
  });
});

describe('talea prune, end to end', () => {
  test('a dry run prints the plan and changes nothing', async () => {
    const ws = path.join(tmp, 'ws');
    mkdirSync(path.join(ws, 'me'), { recursive: true });
    const dir = makeRepo('app', path.join(ws, 'me'));
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    writeFileSync(
      path.join(ws, 'talea.repos.json'),
      JSON.stringify({ repos: [{ name: 'app', owner: 'me', defaultBranch: 'main' }] }),
    );
    writeFileSync(path.join(ws, '.talea.json'), JSON.stringify({ selected: ['app'] }));

    const out = [];
    const log = console.log;
    const cwd = process.cwd();
    console.log = (s = '') => out.push(String(s));
    try {
      process.chdir(ws);
      await run({});
    } finally {
      console.log = log;
      process.chdir(cwd);
    }
    const text = out.join('\n');
    assert.match(text, /merged/);
    assert.match(text, /would free/);
    assert.equal(existsSync(wt), true, 'a dry run removed a worktree');
    assert.equal(process.exitCode ?? 0, 0);
  });
});
