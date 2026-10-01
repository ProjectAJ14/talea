// `talea prune` — the one command that deletes, so every verdict is pinned
// against real git. The origin is a local bare repo: nothing reaches a network.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `run()` records the workspace in ~/.talea/state.json; keep that out of the
// developer's own list. Set before the import: config.js reads home on load.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = home;
const { planRepo, applyRepo, nestedLoss, staleLock, formatAge, run } = await import('../src/commands/prune.js');
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
// The lock Claude Code puts on an agent's worktree. A pid of a process that
// has already exited makes it a leftover.
const agentLock = (pid, start = 'Wed Sep 30 20:22:41 2026') => `claude agent agent-x (pid ${pid} start ${start})`;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
// What `ps` says about this test process; Windows has no `ps`, and any string
// reads the same there: unknown, so held.
const ownStart = () =>
  process.platform === 'win32' ? 'unknown' : execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
const DAY = 24 * 3600 * 1000;

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
    assert.equal(entryOf(plan, outer).held[0].why, 'worktree');
    await applyRepo(dir, plan);
    assert.equal(existsSync(path.join(inner, 'WIP.txt')), true, 'nested work was deleted');
  });

  test('a clean repo inside it whose HEAD is on its remote does not keep it', async () => {
    // Found on a real machine: `flutter build ios` leaves SwiftPM clones under
    // build/, and judged by where they sat they kept 29 GB of merged worktrees.
    // One outside a build folder is judged the same way: by what it holds.
    const dir = makeRepo('nested-clean');
    makeRepo('dep');
    writeFileSync(path.join(dir, '.gitignore'), 'build/\nvendor/\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    for (const at of ['build/ios/SourcePackages/checkouts/dep', 'vendor/dep']) {
      git(['clone', '-q', path.join(tmp, 'dep.git'), path.join(wt, at)], tmp);
    }

    // Its own ignored files are judged like the worktree's: a .env in it is a loss.
    writeFileSync(path.join(wt, 'vendor', 'dep', '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(path.join(wt, 'vendor', 'dep', '.env'), 'SECRET=1\n');
    const kept = entryOf(await planRepo(repo(dir)), wt);
    assert.equal(kept.verdict, 'ignored');
    assert.deepEqual(kept.lossy, ['vendor/dep/.env']);
    rmSync(path.join(wt, 'vendor', 'dep', '.env'));

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'merged');
    await applyRepo(dir, plan);
    assert.equal(existsSync(wt), false);
  });

  test('a repo inside it with work of its own keeps it, and says which', async () => {
    const dir = makeRepo('nested-work');
    makeRepo('lib');
    writeFileSync(path.join(dir, '.gitignore'), 'vendor/\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    const inside = (name) => {
      const at = path.join(wt, 'vendor', name);
      git(['clone', '-q', path.join(tmp, 'lib.git'), at], tmp);
      git(['config', 'user.email', 'test@example.com'], at);
      git(['config', 'user.name', 'test'], at);
      return at;
    };
    writeFileSync(path.join(inside('dirty'), 'WIP.txt'), 'unsaved\n');
    commit(inside('unpushed'), 'local.txt');
    const stashed = inside('stashed');
    writeFileSync(path.join(stashed, 'README.md'), 'changed\n');
    git(['stash', '-q'], stashed);
    // No remote at all: nothing it holds is anywhere else.
    git(['remote', 'remove', 'origin'], inside('orphan'));

    const plan = await planRepo(repo(dir));
    const entry = entryOf(plan, wt);
    assert.equal(entry.verdict, 'nested');
    assert.deepEqual(entry.held.map((h) => `${h.path} ${h.why}`).sort(), [
      'vendor/dirty dirty',
      'vendor/orphan unpushed',
      'vendor/stashed stash',
      'vendor/unpushed unpushed',
    ]);
    await applyRepo(dir, plan);
    assert.equal(existsSync(path.join(wt, 'vendor', 'dirty', 'WIP.txt')), true, 'nested work was deleted');
  });

  test('a .git git cannot read is a loss, never the outer worktree read instead', async () => {
    const dir = makeRepo('nested-broken');
    const broken = path.join(dir, 'vendor', 'broken');
    mkdirSync(path.join(broken, '.git'), { recursive: true });
    assert.equal(await nestedLoss(broken), 'unreadable');
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

  test('a merged worktree locked by an agent that has exited is unlocked and removed', async () => {
    const dir = makeRepo('stale-lock');
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    git(['worktree', 'lock', '--reason', agentLock(deadPid()), wt], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'merged');
    assert.equal(entryOf(plan, wt).stale, true);
    await applyRepo(dir, plan);
    assert.equal(verdictOf(plan, wt), 'removed');
    assert.equal(existsSync(wt), false);
  });

  test('a stale lock on unmerged work is still kept, and stays locked', async () => {
    const dir = makeRepo('stale-unmerged');
    const wt = addWorktree(dir, 'feat');
    git(['worktree', 'lock', '--reason', agentLock(deadPid()), wt], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'unmerged');
    await applyRepo(dir, plan);
    assert.match(git(['worktree', 'list', '--porcelain'], dir), /locked claude agent/);
  });

  test('an agent lock whose process is still running is kept, even when merged', async () => {
    const dir = makeRepo('live-lock');
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    git(['worktree', 'lock', '--reason', agentLock(process.pid, ownStart()), wt], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'locked');
    await applyRepo(dir, plan);
    assert.equal(existsSync(wt), true);
  });

  test('a lock with a reason of its own is kept, merged or not', async () => {
    const dir = makeRepo('own-lock');
    const merged = addWorktree(dir, 'a');
    git(['push', '-q', 'origin', 'a:main'], dir);
    const unmerged = addWorktree(dir, 'b');
    git(['worktree', 'lock', '--reason', 'on a USB drive', merged], dir);
    git(['worktree', 'lock', '--reason', `pid ${deadPid()} is mine`, unmerged], dir);

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, merged), 'locked');
    assert.equal(verdictOf(plan, unmerged), 'locked');
    assert.equal(entryOf(plan, merged).lockReason, 'on a USB drive');
  });

  test('a stale-locked worktree deleted by hand has its record cleared', async () => {
    const dir = makeRepo('stale-missing');
    const wt = addWorktree(dir, 'feat');
    git(['worktree', 'lock', '--reason', agentLock(deadPid()), wt], dir);
    rmSync(wt, { recursive: true, force: true });

    const plan = await planRepo(repo(dir));
    assert.equal(verdictOf(plan, wt), 'missing');
    await applyRepo(dir, plan);
    assert.equal(verdictOf(plan, wt), 'cleared');
    assert.equal(git(['worktree', 'list', '--porcelain'], dir).includes('feat'), false);
  });

  test('a stale lock git will not lift is reported, and nothing is removed', async () => {
    const dir = makeRepo('unlock-fails');
    const plan = { worktrees: [{ path: path.join(tmp, 'not-a-worktree'), verdict: 'merged', stale: true, lossy: [] }] };
    await applyRepo(dir, plan);
    assert.equal(plan.worktrees[0].verdict, 'failed');
    assert.ok(plan.worktrees[0].error);
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

  test('an ignored folder or file that loses nothing does not keep it', async () => {
    // Found on a real machine: `--directory` folded `.claude/` into one entry,
    // so a folder holding only the seeded settings file read as somebody's
    // work; and a generated file identical to the main checkout's was "lost".
    const dir = makeRepo('recoverable');
    writeFileSync(path.join(dir, '.gitignore'), '.claude/\ntokens.css\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    mkdirSync(path.join(wt, '.claude'));
    writeFileSync(path.join(wt, '.claude', 'settings.local.json'), '{}\n');
    writeFileSync(path.join(dir, 'tokens.css'), 'a{}\n');
    writeFileSync(path.join(wt, 'tokens.css'), 'a{}\n');

    assert.equal(verdictOf(await planRepo(repo(dir)), wt), 'merged');

    // The same file, changed in the worktree, is a real loss again.
    writeFileSync(path.join(wt, 'tokens.css'), 'b{}\n');
    const entry = entryOf(await planRepo(repo(dir)), wt);
    assert.equal(entry.verdict, 'ignored');
    assert.deepEqual(entry.lossy, ['tokens.css']);
  });

  test('a file the repo marks talea-regenerable does not keep it', async () => {
    // Found on a real machine: a build copies a tracked doc into public/, the
    // main checkout's copy was a week stale, so every merged worktree was kept.
    const dir = makeRepo('marked');
    writeFileSync(path.join(dir, '.gitignore'), 'public/\n.env\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    mkdirSync(path.join(wt, 'public'));
    writeFileSync(path.join(wt, 'public', 'runtime.html'), 'new\n');
    writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
    mkdirSync(path.join(dir, 'public'));
    writeFileSync(path.join(dir, 'public', 'runtime.html'), 'stale\n');
    assert.deepEqual(entryOf(await planRepo(repo(dir)), wt).lossy.sort(), ['.env', 'public/runtime.html']);

    // Declared on main after the worktree branched: the base's word counts,
    // and it covers only what it names — the .env still keeps the worktree.
    git(['merge', '-q', '--ff-only', 'feat'], dir);
    writeFileSync(path.join(dir, '.gitattributes'), 'public/** talea-regenerable\n');
    commit(dir, 'attrs.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const entry = entryOf(await planRepo(repo(dir)), wt);
    assert.equal(entry.verdict, 'ignored');
    assert.deepEqual(entry.lossy, ['.env']);

    rmSync(path.join(wt, '.env'));
    assert.equal(verdictOf(await planRepo(repo(dir)), wt), 'merged');
  });

  test('the mark also counts from the worktree itself and .git/info/attributes, and only when set', async () => {
    const dir = makeRepo('marked-here');
    writeFileSync(path.join(dir, '.gitignore'), '*.gen\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    // Declared on the branch itself, not yet on main.
    writeFileSync(path.join(wt, '.gitattributes'), 'a.gen talea-regenerable\nb.gen -talea-regenerable\n');
    commit(wt, 'attrs.txt');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    for (const f of ['a.gen', 'b.gen', 'c.gen']) writeFileSync(path.join(wt, f), `${f}\n`);

    // An unset mark is no mark: b.gen is still somebody's file.
    assert.deepEqual(entryOf(await planRepo(repo(dir)), wt).lossy.sort(), ['b.gen', 'c.gen']);

    // A mark this machine alone keeps, shared by every worktree of the repo.
    const info = path.join(dir, '.git', 'info');
    mkdirSync(info, { recursive: true });
    writeFileSync(path.join(info, 'attributes'), 'c.gen talea-regenerable\n');
    assert.deepEqual(entryOf(await planRepo(repo(dir)), wt).lossy, ['b.gen']);
  });

  test('what Flutter writes is build output by talea\'s own list; a .env still is not', async () => {
    // Found on a real machine: ~80 files of Flutter and IDE output, none
    // byte-identical to the main checkout's, kept a merged worktree as ignored.
    const dir = makeRepo('flutter');
    writeFileSync(
      path.join(dir, '.gitignore'),
      ['ephemeral/', '.flutter-plugins-dependencies', 'local.properties', 'Generated.xcconfig', '*.iml', '.idea/', 'pubspec.lock', '.env', ''].join('\n'),
    );
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    const write = (rel, text = rel) => {
      mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
      writeFileSync(path.join(wt, rel), `${text} in the worktree\n`);
    };
    for (const f of [
      'ios/Flutter/ephemeral/flutter_lldbinit',
      'macos/Flutter/ephemeral/Packages/x/y.swift',
      'ios/Flutter/Generated.xcconfig',
      '.flutter-plugins-dependencies',
      'android/local.properties',
      'quietflip.iml',
      '.idea/modules.xml',
      'pubspec.lock',
    ]) write(f);
    write('.env');

    const entry = entryOf(await planRepo(repo(dir)), wt);
    assert.equal(entry.verdict, 'ignored');
    assert.deepEqual(entry.lossy, ['.env']);

    // The repo's own word beats talea's list.
    rmSync(path.join(wt, '.env'));
    const info = path.join(dir, '.git', 'info');
    mkdirSync(info, { recursive: true });
    writeFileSync(path.join(info, 'attributes'), 'pubspec.lock -talea-regenerable\n');
    assert.deepEqual(entryOf(await planRepo(repo(dir)), wt).lossy, ['pubspec.lock']);
  });

  test('a file of your own inside an ignored folder still keeps it', async () => {
    // Opening a folded folder must not lose what it holds: the seeded settings
    // file goes, the notes beside it are named and keep the worktree.
    const dir = makeRepo('opened');
    writeFileSync(path.join(dir, '.gitignore'), '.plan/\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    mkdirSync(path.join(wt, '.plan', 'node_modules'), { recursive: true });
    writeFileSync(path.join(wt, '.plan', 'node_modules', 'x.js'), '1\n');
    writeFileSync(path.join(wt, '.plan', 'notes.md'), 'mine\n');

    const plan = await planRepo(repo(dir));
    const entry = entryOf(plan, wt);
    assert.equal(entry.verdict, 'ignored');
    assert.deepEqual(entry.lossy, ['.plan/notes.md']);
    await applyRepo(dir, plan);
    assert.equal(existsSync(path.join(wt, '.plan', 'notes.md')), true, 'the notes were deleted');
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
    assert.ok(entryOf(plan, wt).age < 3600);
    await applyRepo(dir, plan);
    assert.equal(existsSync(wt), true);
  });

  test('a branch with no commits, cut over a day ago, is unused and removed', async () => {
    const dir = makeRepo('unused');
    const wt = path.join(`${dir}-worktrees`, 'old-task');
    git(['worktree', 'add', '-q', '-b', 'old-task', wt], dir);

    const plan = await planRepo(repo(dir), { now: Date.now() + 2 * DAY });
    assert.equal(verdictOf(plan, wt), 'unused');
    assert.ok(entryOf(plan, wt).age >= 2 * 24 * 3600 - 60);
    await applyRepo(dir, plan);
    assert.equal(verdictOf(plan, wt), 'removed');
    assert.equal(existsSync(wt), false);
    assert.equal(git(['branch', '--list', 'old-task'], dir).replace(/^[*+ ]+/, ''), 'old-task');
  });

  test('an unused worktree holding ignored files you made is kept as ignored', async () => {
    const dir = makeRepo('unused-ignored');
    writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    commit(dir, 'keep.txt');
    git(['push', '-q', 'origin', 'main'], dir);
    const wt = path.join(`${dir}-worktrees`, 'old-task');
    git(['worktree', 'add', '-q', '-b', 'old-task', wt], dir);
    writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');

    const plan = await planRepo(repo(dir), { now: Date.now() + 2 * DAY });
    assert.equal(verdictOf(plan, wt), 'ignored');
  });
});

describe('staleLock', () => {
  test('only a claude agent lock can be stale', async () => {
    assert.equal(await staleLock(null), false);
    assert.equal(await staleLock('on a USB drive'), false);
    assert.equal(await staleLock(agentLock(deadPid())), true);
  });

  test('a live pid is stale only when its start time proves it was reused', async () => {
    const lock = agentLock(process.pid, 'Wed Sep 30 20:22:41 2026');
    assert.equal(await staleLock(lock, { started: async () => 'Thu Oct  1 09:00:00 2026' }), true);
    assert.equal(await staleLock(lock, { started: async () => 'Wed Sep 30 20:22:41 2026' }), false);
    assert.equal(await staleLock(lock, { started: async () => '' }), false, 'no ps: cannot tell, so held');
    assert.equal(await staleLock(agentLock(process.pid, 'sometime'), { started: async () => 'Wed Sep 30 20:22:41 2026' }), false);
  });

  test('a pid owned by another user is alive, so the lock is held', async () => {
    const kill = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    assert.equal(await staleLock(agentLock(1), { kill }), false);
  });
});

describe('formatAge', () => {
  test('minutes, hours, days', () => {
    assert.equal(formatAge(125), '2m');
    assert.equal(formatAge(7 * 3600 + 5), '7h');
    assert.equal(formatAge(3 * 86400 + 5), '3d');
  });
});

describe('talea prune, end to end', () => {
  test('a dry run prints the plan and changes nothing', async () => {
    const ws = path.join(tmp, 'ws');
    mkdirSync(path.join(ws, 'me'), { recursive: true });
    const dir = makeRepo('app', path.join(ws, 'me'));
    const wt = addWorktree(dir, 'feat');
    git(['push', '-q', 'origin', 'feat:main'], dir);
    git(['worktree', 'lock', '--reason', agentLock(deadPid()), wt], dir);
    git(['worktree', 'add', '-q', '-b', 'new-task', path.join(`${dir}-worktrees`, 'new-task')], dir);
    const held = addWorktree(dir, 'held');
    git(['worktree', 'lock', '--reason', 'on a USB drive', held], dir);
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
    assert.match(text, /merged.* · stale lock/);
    assert.match(text, /fresh.* · \d+m/);
    assert.match(text, /locked: on a USB drive/);
    assert.match(text, /would free/);
    assert.equal(existsSync(wt), true, 'a dry run removed a worktree');
    assert.equal(process.exitCode ?? 0, 0);
  });
});
