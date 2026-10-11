// `talea adopt` end to end: real git, real workspaces, the command's own output.
//
// One workspace is walked through the life a developer would give it — look,
// apply, look again at what was held back, apply that by name, repair paths —
// and a few small ones pin the edges. Origins are local bare repos.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import cp from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-adoptcmd-home-')));
process.env.HOME = process.env.USERPROFILE = home;
const { run, applyMoves, refixPaths, parseFromPaths, quoted, reportUnreadable } = await import('../src/commands/adopt.js');
const { claudeSlug, DUPLICATES_DIR } = await import('../src/adopt.js');
const cloneCmd = await import('../src/commands/clone.js');
const syncCmd = await import('../src/commands/sync.js');
const addCmd = await import('../src/commands/add.js');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-adoptcmd-')));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const origins = {};
/** A bare origin with one commit on main, made once per name. */
function origin(name) {
  if (origins[name]) return origins[name];
  const bare = path.join(tmp, 'origins', `${name}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', bare], tmp);
  const seed = path.join(tmp, 'seeds', name);
  git(['clone', '-q', bare, seed], tmp);
  git(['config', 'user.email', 't@example.com'], seed);
  git(['config', 'user.name', 't'], seed);
  git(['checkout', '-q', '-b', 'main'], seed);
  writeFileSync(path.join(seed, 'README.md'), 'x\n');
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'init'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  return (origins[name] = bare);
}

function clone(name, dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  git(['clone', '-q', origin(name), dir], tmp);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 't'], dir);
  return dir;
}

const commitFiles = (dir, files) => {
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, f), body);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'files'], dir);
};

function workspace(name, repos, state = {}) {
  const ws = path.join(tmp, name);
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'talea.repos.json'), JSON.stringify({ repos }));
  writeFileSync(path.join(ws, '.talea.json'), JSON.stringify(state));
  return ws;
}

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

/** Claude Code "running" or not, whatever this machine is doing. */
const claude = (running, fn) =>
  stubbed(
    cp,
    'spawnSync',
    (orig) =>
      (cmd, ...rest) =>
        cmd === 'pgrep' || cmd === 'tasklist'
          ? { status: running ? 0 : 1, stdout: running ? 'claude.exe' : '' }
          : orig(cmd, ...rest),
    fn,
  );

/** Run in `cwd`, capturing both streams; exitCode is reported and reset. */
async function capture(cwd, fn) {
  const out = [];
  const { log, error } = console;
  const prev = process.cwd();
  console.log = (s = '') => out.push(String(s));
  console.error = (s = '') => out.push(String(s));
  try {
    process.chdir(cwd);
    await fn();
  } finally {
    console.log = log;
    console.error = error;
    process.chdir(prev);
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  // eslint-disable-next-line no-control-regex
  return { text: out.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), exitCode };
}

describe('talea adopt, over the life of one workspace', () => {
  let ws, desktop, appFrom, libFrom, appTo, libTo;

  before(() => {
    desktop = path.join(home, 'Desktop');
    ws = workspace('ws1', [
      { name: 'app', owner: 'me', url: origin('app') },
      { name: 'lib', owner: 'me', url: 'git@github.com:me/lib.git' }, // origin is local: name-only
      { name: 'twin', owner: 'me', url: origin('twin') },
      { name: 'blocked', owner: 'me', url: origin('blocked') },
      { name: 'ign', owner: 'me', url: origin('ign'), ignore: true },
    ]);

    // app: the copy inside the workspace wins; it has worktrees and config.
    appFrom = clone('app', path.join(ws, 'other', 'app'));
    appTo = path.join(ws, 'me', 'app');
    git(['worktree', 'add', '-q', '-b', 'x', path.join(`${appFrom}-worktrees`, 'x')], appFrom);
    const gone = path.join(tmp, 'gone-y');
    git(['worktree', 'add', '-q', '-b', 'y', gone], appFrom);
    git(['worktree', 'lock', gone], appFrom);
    rmSync(gone, { recursive: true, force: true });
    commitFiles(appFrom, { 'CLAUDE.md': `cd ${appFrom}\n`, '.envrc': `export D=${appFrom}\n` });
    git(['push', '-q', 'origin', 'HEAD:main'], appFrom);
    writeFileSync(path.join(ws, 'CLAUDE.md'), `app lives at ${appFrom}\nsee ${appFrom}/README.md\n`); // untracked: ws is no repo
    // ...and a second, dirty copy on the Desktop.
    clone('app', path.join(desktop, 'app'));
    writeFileSync(path.join(desktop, 'app', 'wip.txt'), 'unsaved');

    // twin: already in place, with a clean second copy.
    clone('twin', path.join(ws, 'me', 'twin'));
    clone('twin', path.join(ws, 'spare', 'twin'));

    // lib: name-only, with two nested worktrees and a tracked config file.
    libFrom = clone('lib', path.join(ws, 'other', 'lib'));
    libTo = path.join(ws, 'me', 'lib');
    for (const b of ['a', 'b']) git(['worktree', 'add', '-q', '-b', b, path.join(libFrom, '.claude', 'worktrees', b)], libFrom);
    commitFiles(libFrom, { 'CLAUDE.md': `cd ${libFrom}\n` });
    clone('lib', path.join(desktop, 'lib'));

    // blocked: the destination is somebody else's folder.
    mkdirSync(path.join(ws, 'me', 'blocked'), { recursive: true });
    writeFileSync(path.join(ws, 'me', 'blocked', 'THEIRS'), '');
    clone('blocked', path.join(desktop, 'blocked'));

    clone('ign', path.join(desktop, 'ign'));

    // Things that name the old paths.
    const projects = path.join(home, '.claude', 'projects');
    mkdirSync(path.join(projects, claudeSlug(appFrom)), { recursive: true });
    mkdirSync(path.join(projects, claudeSlug(libFrom)), { recursive: true });
    writeFileSync(path.join(projects, claudeSlug(libFrom), 'old.jsonl'), '');
    mkdirSync(path.join(projects, claudeSlug(libTo)), { recursive: true });
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [appFrom]: {}, [libFrom]: {}, [libTo]: {} } }),
    );
    writeFileSync(path.join(home, '.zshrc'), `alias app="cd ${appFrom}"\n`);
    writeFileSync(path.join(home, '.claude', 'history.jsonl'), JSON.stringify({ cwd: libFrom }) + '\n');
  });

  test('a dry run lists every move, park and refusal, and moves nothing', async () => {
    const { text, exitCode } = await capture(ws, () => run({ from: '~/Desktop', jobs: 2 }));
    assert.equal(exitCode, 0);
    assert.match(text, /searching 2 locations, 4 repos in scope/);
    assert.match(text, /1 already in the right place/);
    assert.match(text, /app\n\s+from .*other[\\/]app\n\s+to\s+me[\\/]app/);
    assert.match(text, /2 matched on repo name only/);
    assert.match(text, /app — second copy\n\s+from\s+~[\\/]Desktop[\\/]app[\s\S]*holds 1 uncommitted change/);
    assert.match(text, /twin — second copy/);
    assert.match(text, /blocked left alone — destination already exists and is not empty/);
    assert.match(text, /Re-run with --apply to move 1 into place and park 2 second copies and leave 2 name-only matches alone\./);
    assert.doesNotMatch(text, /ign/);
    assert.equal(existsSync(appFrom), true);
    assert.equal(existsSync(appTo), false);
  });

  test('--apply moves exact matches, parks their copies, and leaves name-only ones', async () => {
    const { text, exitCode } = await capture(ws, () => claude(true, () => run({ apply: true, from: desktop })));
    assert.equal(exitCode, 0);
    assert.equal(existsSync(appTo), true);
    assert.equal(existsSync(appFrom), false);
    assert.equal(existsSync(path.join(ws, DUPLICATES_DIR, 'me', 'app', 'wip.txt')), true, 'park lost work');
    assert.equal(existsSync(path.join(ws, DUPLICATES_DIR, 'me', 'twin')), true);
    assert.equal(existsSync(libFrom), true, 'a name-only match was moved unattended');

    assert.match(text, /worktrees .*other[\\/]app-worktrees → me[\\/]app-worktrees/);
    assert.match(text, /1 worktree re-linked \(1 unreachable, left registered\)/);
    assert.match(text, /Claude session history and memory/);
    assert.match(text, /~\/\.claude\.json project entry\n/);
    assert.match(text, /\sCLAUDE\.md \(2 paths\)/); // the workspace's own, untracked
    assert.match(text, /me[\\/]app[\\/]CLAUDE\.md \(1 path\)/);
    assert.match(text, /lib left alone — matched on name only[\s\S]*github|lib left alone — matched on name only/);
    assert.match(text, /fully redundant/);
    assert.match(text, /holds 1 uncommitted change/);
    assert.match(text, /2 second copies parked in/);
    assert.match(text, /2 rewritten files are tracked by git/);
    assert.match(text, /these need you\n\s+! ~\/\.zshrc line 1/);
    assert.doesNotMatch(text, /Left alone on purpose/);
    assert.match(text, /A Claude Code process is running/);
    assert.match(text, /To sweep anything/);

    const state = JSON.parse(readFileSync(path.join(ws, '.talea.json'), 'utf8'));
    assert.deepEqual(state.scanPaths, [desktop]);
    assert.equal(state.adopted.length, 1);
    assert.equal(readFileSync(path.join(appTo, 'CLAUDE.md'), 'utf8'), `cd ${appTo}\n`);
    assert.ok(path.join(appTo) in JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')).projects);
  });

  test('naming a name-only match is the instruction to include it', async () => {
    const { text } = await capture(ws, () => run({ repo: 'lib' }));
    assert.match(text, /Re-run with --apply to move 1 into place and park 1 second copy\./);

    const applied = await capture(ws, () => claude(false, () => run({ repo: 'lib', apply: true })));
    assert.equal(applied.exitCode, 0);
    assert.equal(existsSync(libTo), true);
    assert.match(applied.text, /2 worktrees re-linked\n/);
    assert.match(applied.text, /Claude history merged \(1 moved, 0 already there\)/);
    assert.match(applied.text, /dropped the stale entry/);
    assert.match(applied.text, /1 second copy parked in/);
    assert.match(applied.text, /1 rewritten file is tracked by git/);
    assert.match(applied.text, /Left alone on purpose:\n\s+~\/\.claude\/history\.jsonl/);
    assert.doesNotMatch(applied.text, /these need you/);
    assert.doesNotMatch(applied.text, /A Claude Code process is running/);
    const state = JSON.parse(readFileSync(path.join(ws, '.talea.json'), 'utf8'));
    assert.deepEqual(state.adopted.map((a) => a.repo), ['me/app', 'me/lib']);
  });

  test('--fix-paths replays every recorded move and lists what it will not touch', async () => {
    const { text } = await capture(ws, () => run({ 'fix-paths': true }));
    assert.match(text, /Repairing paths/);
    assert.match(text, /app .*other[\\/]app → me[\\/]app/);
    assert.match(text, /! ~\/\.zshrc line 1 — shell aliases/);
    assert.match(text, /· ~\/\.claude\/history\.jsonl\s+— a log/);
  });
});

describe('talea adopt, the small cases', () => {
  test('only a refusal: nothing to apply, and the counts are singular', async () => {
    const ws = workspace('ws2', [{ name: 'solo', owner: 'me', url: origin('solo') }]);
    mkdirSync(path.join(ws, 'me', 'solo'), { recursive: true });
    writeFileSync(path.join(ws, 'me', 'solo', 'THEIRS'), '');
    clone('solo', path.join(ws, 'stray', 'solo'));

    const dry = await capture(ws, () => run({}));
    assert.match(dry.text, /searching 1 location, 1 repo in scope/);
    assert.match(dry.text, /solo left alone/);
    assert.match(dry.text, /Nothing to apply\./);

    const applied = await capture(ws, () => run({ apply: true }));
    assert.match(applied.text, /nothing to do/);
    assert.doesNotMatch(applied.text, /To sweep/);
  });

  test('everything in place: nothing to adopt, and nothing recorded to repair', async () => {
    const ws = workspace('ws3', [{ name: 'home', owner: 'me', url: origin('home') }]);
    clone('home', path.join(ws, 'me', 'home'));
    const dry = await capture(ws, () => run({}));
    assert.match(dry.text, /1 already in the right place/);
    assert.match(dry.text, /Nothing to adopt\./);
    const fix = await capture(ws, () => run({ 'fix-paths': true }));
    assert.match(fix.text, /Nothing recorded/);
  });

  test('one name-only match is left alone, and says so in the singular', async () => {
    const ws = workspace('ws7', [{ name: 'guess', owner: 'me', url: 'git@github.com:me/guess.git' }]);
    clone('guess', path.join(ws, 'loose', 'guess'));
    const dry = await capture(ws, () => run({}));
    assert.match(dry.text, /Re-run with --apply to leave 1 name-only match alone\./);
  });

  test('a plain exact move: no warning, no leftovers', async () => {
    const ws = workspace('ws4', [{ name: 'plain', owner: 'me', url: origin('plain') }]);
    const from = clone('plain', path.join(ws, 'loose', 'plain'));
    const dry = await capture(ws, () => run({}));
    assert.doesNotMatch(dry.text, /name only/);
    assert.match(dry.text, /Re-run with --apply to move 1 into place\./);
    const applied = await capture(ws, () => claude(false, () => run({ apply: true })));
    assert.equal(existsSync(path.join(ws, 'me', 'plain')), true);
    assert.equal(existsSync(from), false);
    assert.doesNotMatch(applied.text, /Still pointing|Left alone on purpose|tracked by git/);
  });
});

describe('applyMoves, when things go wrong', () => {
  test('a failed move holds back its duplicates; a failed park is reported', async () => {
    const root = path.join(tmp, 'ws5');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, '.talea.json'), '{}');
    const repo = { name: 'r' };
    const nowhere = path.join(tmp, 'no-such-checkout');
    const copy = clone('r', path.join(tmp, 'r-copy'));

    const { text, exitCode } = await capture(root, async () => {
      const res = await applyMoves(
        root,
        [{ repo, from: nowhere, to: path.join(root, 'failed-target') }],
        [
          { repo, from: copy, keeping: path.join(root, 'failed-target'), holds: [] },
          { repo, from: copy, keeping: path.join(root, 'never-there'), holds: [] },
          { repo, from: nowhere, keeping: root, holds: [] },
          { repo, from: copy, keeping: root, holds: [] },
        ],
      );
      assert.equal(res.results[0].ok, false);
      assert.equal(res.parked.length, 1);
    });
    assert.equal(exitCode, 0);
    assert.match(text, /r\n\s+\S*no-such-checkout is no longer there — nothing was moved/);
    assert.match(text, /second copy left where it is — failed-target is not in place/);
    assert.match(text, /never-there is not in place/);
    assert.match(text, /r second copy\n\s+\S*no-such-checkout is no longer there/);
    assert.match(text, new RegExp(`second copy — ${root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} is the one in use`));
  });

  test('refixPaths reports a history move or settings file it could not fix', async () => {
    const root = path.join(tmp, 'ws6');
    const from = path.join(tmp, 'refix-from');
    const to = path.join(root, 'me', 'z');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, '.talea.json'), JSON.stringify({ adopted: [{ repo: 'z', from, to }] }));
    mkdirSync(path.join(home, '.claude', 'projects', claudeSlug(from)), { recursive: true });
    writeFileSync(path.join(home, '.claude.json'), '{broken');
    const { text } = await capture(root, () =>
      stubbed(fs, 'renameSync', () => () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }, () => assert.deepEqual(refixPaths(root), { count: 1 })),
    );
    assert.match(text, /Claude history not moved: EPERM/);
    assert.match(text, /~\/\.claude\.json not updated: could not parse/);
  });
});

describe('a worktree git will not re-link', () => {
  /** `git worktree repair` exits 1 and changes nothing, for the length of `fn`. */
  const repairFails = (fn) =>
    stubbed(cp, 'spawnSync', (orig) => (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'worktree' && args[1] === 'repair' ? { status: 1, stdout: '', stderr: '' } : orig(cmd, args, opts),
      fn,
    );
  /** A stray checkout of `wt` with a worktree outside it. */
  const strayWithWorktree = (at, ...fars) => {
    const dir = clone('wt', at);
    for (const far of fars) git(['worktree', 'add', '-q', '-b', path.basename(far), far], dir);
    return dir;
  };

  test('adopt moves and parks, names each unlinked worktree with its fix, and fails the run', async () => {
    const ws = workspace('ws-unlinked', [{ name: 'wt', owner: 'me', url: origin('wt') }]);
    const farA = path.join(tmp, 'far-a');
    const farB = path.join(tmp, 'far-b');
    strayWithWorktree(path.join(ws, 'a', 'wt'), farA, `${farA}-2`);
    strayWithWorktree(path.join(ws, 'b', 'wt'), farB);

    const { text, exitCode } = await repairFails(() => capture(ws, () => claude(false, () => run({ apply: true }))));
    assert.equal(exitCode, 1);
    const target = path.join(ws, 'me', 'wt');
    assert.equal(existsSync(path.join(target, '.git')), true, 'the move itself was undone');
    assert.match(text, /2 worktrees could not be re-linked — the files are untouched:/);
    assert.match(text, /1 worktree could not be re-linked/);
    assert.match(text, /git: git exited 1/);
    // Paths as git prints them: the long, forward-slash form on Windows.
    assert.match(text, /once that is fixed: git -C "[^"]+" worktree repair "[^"]*far-a"/);
    assert.match(text, /worktree repair "[^"]*far-a-2"/);
    assert.match(text, /no GIT_DIR or GIT_WORK_TREE set/);
    // One repo moved, one parked, both with a worktree left unlinked: two failures, no successes.
    assert.match(text, /2 failed/);
    assert.doesNotMatch(text, /relocated/);
    assert.match(text, /worktree repair "[^"]*far-b"/, 'the parked copy\'s worktree was not named');
    // The command it names works.
    git(['worktree', 'repair', farA], target);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], farA), 'true');
  });

  test('clone and sync fail the run too, after moving the checkout into place', async () => {
    const ws = workspace('ws-unlinked-clone', [{ name: 'wt', owner: 'me', url: origin('wt') }], { selected: ['me/wt'] });
    strayWithWorktree(path.join(ws, 'a', 'wt'), path.join(tmp, 'far-c'));
    const { text, exitCode } = await repairFails(() => capture(ws, () => claude(false, () => cloneCmd.run({ jobs: 1 }))));
    assert.equal(exitCode, 1);
    assert.match(text, /could not be re-linked/);
    assert.match(text, /1 failed/);
    assert.equal(existsSync(path.join(ws, 'me', 'wt', '.git')), true);

    // sync, on a fresh stray: never ALL CLEAR over a broken worktree.
    rmSync(path.join(ws, 'me'), { recursive: true, force: true });
    strayWithWorktree(path.join(ws, 'b', 'wt'), path.join(tmp, 'far-d'));
    const synced = await repairFails(() => capture(ws, () => claude(false, () => syncCmd.run({ jobs: 1 }))));
    assert.equal(synced.exitCode, 1);
    assert.match(synced.text, /1 failed/);
    assert.doesNotMatch(synced.text, /ALL CLEAR/);

    // add, which adopts the checkout it was asked for.
    rmSync(path.join(ws, 'me'), { recursive: true, force: true });
    writeFileSync(path.join(ws, '.talea.json'), JSON.stringify({ selected: [] }));
    strayWithWorktree(path.join(ws, 'c', 'wt'), path.join(tmp, 'far-e'));
    const added = await repairFails(() => capture(ws, () => claude(false, () => addCmd.run({ jobs: 1 }, ['wt']))));
    assert.equal(added.exitCode, 1);
    assert.match(added.text, /could not be re-linked/);
  });
});

describe('a checkout git will not open', () => {
  /** git's own switch for "another account owns every repo", for the length of `fn`. */
  async function dubious(fn) {
    // NOSYSTEM: hosted CI images set `safe.directory = *` in git's system
    // config, which silences the very refusal this needs. The global config is
    // already the fake home's empty one.
    const keys = ['GIT_TEST_ASSUME_DIFFERENT_OWNER', 'GIT_CONFIG_NOSYSTEM'];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) process.env[k] = '1';
    try {
      return await fn();
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  }
  /** A folder git exits 128 for: a `.git` with nothing in it. */
  const brokenAt = (dir) => mkdirSync(path.join(dir, '.git'), { recursive: true });

  test('adopt names it with git\'s reason and the safe.directory fix, moves nothing, and fails', async () => {
    const ws = workspace('ws-dubious', [{ name: 'own', owner: 'me', url: origin('own') }]);
    const stray = clone('own', path.join(ws, 'stray', 'own'));
    const { text, exitCode } = await dubious(() => capture(ws, () => run({})));
    assert.equal(exitCode, 1, 'a checkout git will not open must fail the run');
    assert.match(text, /stray[\\/]own left alone — git would not open it\n\s+git: fatal: detected dubious ownership/);
    assert.match(text, /if it is yours:\s+git config --global --add safe\.directory '[^']*stray\/own'/);
    assert.match(text, /Nothing else to adopt\./);
    assert.equal(existsSync(path.join(stray, '.git')), true, 'and it is left exactly where it is');
  });

  test('any other refusal gets no safe.directory line, and counts as a failure beside a move', async () => {
    const ws = workspace('ws-broken', [{ name: 'mv', owner: 'me', url: origin('mv') }]);
    clone('mv', path.join(ws, 'loose', 'mv'));
    brokenAt(path.join(ws, 'loose', 'junk'));
    const { text, exitCode } = await capture(ws, () => claude(false, () => run({ apply: true })));
    assert.equal(exitCode, 1);
    assert.match(text, /junk left alone — git would not open it\n\s+git: fatal: not a git repository/);
    assert.doesNotMatch(text, /safe\.directory/);
    assert.match(text, /1 relocated/);
    assert.match(text, /1 failed/);
    assert.equal(existsSync(path.join(ws, 'me', 'mv', '.git')), true);
  });

  test('a repo with no origin at all is not reported — that is a local-only repo, not a refusal', async () => {
    const ws = workspace('ws-local', [{ name: 'home', owner: 'me', url: origin('home') }]);
    git(['init', '-q', path.join(ws, 'notes')], tmp);
    const { text, exitCode } = await capture(ws, () => run({}));
    assert.equal(exitCode, 0);
    assert.doesNotMatch(text, /would not open/);
  });

  test('clone holds back the repo whose folder it has, and counts one that matches nothing', async () => {
    const ws = workspace(
      'ws-held',
      [
        { name: 'beta', owner: 'me', url: origin('beta') },
        { name: 'gamma', owner: 'me', url: origin('gamma') },
      ],
      { selected: ['me/beta', 'me/gamma'] },
    );
    brokenAt(path.join(ws, 'old', 'beta'));
    brokenAt(path.join(ws, 'old', 'zzz'));
    // One already in place is not held back by a stray folder sharing its name.
    clone('gamma', path.join(ws, 'me', 'gamma'));
    brokenAt(path.join(ws, 'old2', 'gamma'));
    const { text, exitCode } = await capture(ws, () => cloneCmd.run({ jobs: 1 }));
    assert.equal(exitCode, 1);
    assert.match(text, /beta left alone — git would not open the copy already on disk/);
    assert.match(text, /3 failed/, 'beta held back, zzz and the stray gamma counted');
    assert.equal(existsSync(path.join(ws, 'me', 'beta')), false, 'no second copy beside it');
  });

  test('sync fails a held-back repo rather than calling it skipped', async () => {
    const ws = workspace('ws-held-sync', [{ name: 'beta', owner: 'me', url: origin('beta') }], { selected: ['me/beta'] });
    brokenAt(path.join(ws, 'old', 'beta'));
    const { text, exitCode } = await capture(ws, () => syncCmd.run({ jobs: 1 }));
    assert.equal(exitCode, 1);
    assert.match(text, /1 failed/);
    assert.doesNotMatch(text, /ALL CLEAR|skipped/);
    assert.equal(existsSync(path.join(ws, 'me', 'beta')), false);
  });
});

describe('a worktree its repo no longer knows', () => {
  /** A repo in place with a linked worktree beside it whose admin folder is gone. */
  function orphaned(name) {
    const ws = workspace(name, [{ name: 'own', owner: 'me', url: origin('own'), defaultBranch: 'main' }], { selected: ['me/own'] });
    const repo = clone('own', path.join(ws, 'me', 'own'));
    const wt = path.join(ws, 'me', 'own-worktrees', 'feat-x');
    git(['worktree', 'add', '-q', '-b', 'feat-x', wt], repo);
    rmSync(path.join(repo, '.git', 'worktrees', 'feat-x'), { recursive: true });
    return { ws, wt };
  }

  test('sync, clone and adopt warn with the fix, and none of them fails over it', async () => {
    // git exits 128 on it, and every run failed forever (found in review).
    const { ws, wt } = orphaned('ws-orphan');
    for (const go of [() => syncCmd.run({ jobs: 1 }), () => cloneCmd.run({ jobs: 1 }), () => run({})]) {
      const { text, exitCode } = await capture(ws, go);
      assert.equal(exitCode, 0, text);
      assert.match(text, /feat-x left alone — a worktree whose repo no longer knows it/);
      assert.match(text, /git worktree repair '[^']*feat-x'/);
      assert.doesNotMatch(text, /would not open|failed/);
    }
    assert.equal(existsSync(path.join(wt, '.git')), true, 'and nothing deleted it');
  });
});

describe('a checkout git will not open, at its own catalogue path', () => {
  test('is failed once by sync and not fetched, and clone counts it the same way', async () => {
    const ws = workspace('ws-at-path', [{ name: 'beta', owner: 'me', url: origin('beta') }], { selected: ['me/beta'] });
    mkdirSync(path.join(ws, 'me', 'beta', '.git'), { recursive: true });
    // It was failed as matching nothing, then fetched and failed again:
    // "2 need attention" for one repo (found in review).
    const synced = await capture(ws, () => syncCmd.run({ jobs: 1 }));
    assert.equal(synced.exitCode, 1);
    assert.match(synced.text, /beta left alone — git would not open the copy already on disk/);
    assert.match(synced.text, /1 failed/);
    assert.doesNotMatch(synced.text, /fetch failed|skipped/);
    const cloned = await capture(ws, () => cloneCmd.run({ jobs: 1 }));
    assert.equal(cloned.exitCode, 1);
    assert.match(cloned.text, /1 failed/);
    assert.doesNotMatch(cloned.text, /skipped/);
  });
});

describe('reportUnreadable', () => {
  const said = (u, platform) => {
    const lines = [];
    const saved = [console.log, console.error, process.exitCode];
    console.log = console.error = (...a) => lines.push(a.join(' '));
    try {
      reportUnreadable([u], platform);
    } finally {
      [console.log, console.error] = saved;
      process.exitCode = saved[2];
    }
    return lines.join('\n');
  };

  test('slashes are turned for safe.directory on Windows only — a backslash is a POSIX name character', () => {
    const u = (dir) => ({ dir, error: 'fatal: detected dubious ownership', dubious: true });
    assert.match(said(u('C:\\src\\app'), 'win32'), /safe\.directory 'C:\/src\/app'/);
    assert.match(said(u('/src/we\\ird'), 'linux'), /safe\.directory '\/src\/we\\ird'/);
    assert.doesNotMatch(said({ dir: '/x', error: 'fatal: not a git repository' }, 'linux'), /safe\.directory/);
  });
});

describe('printed commands on Windows', () => {
  test('the park cleanup and the sweep are PowerShell, not sh', async () => {
    const run2 = async (platform, name) => {
      const ws = workspace(name, [{ name: 'pw', owner: 'me', url: origin('pw') }]);
      clone('pw', path.join(ws, 'a', 'pw'));
      clone('pw', path.join(ws, 'b', 'pw'));
      const { text } = await capture(ws, () => claude(false, () => onPlatform(platform, () => run({ apply: true }))));
      return { text, ws };
    };
    const win = await run2('win32', 'ws-pwsh');
    assert.match(win.text, /Remove-Item -Recurse -Force '[^']*\.talea-duplicates'/);
    assert.match(win.text, /Get-ChildItem '[^']+',"\$HOME" -Recurse -File .*Select-String -SimpleMatch -List '[^']*a[\\/]pw'/);
    assert.doesNotMatch(win.text, /rm -rf|grep -rl/);
    const posix = await run2('linux', 'ws-sh');
    assert.match(posix.text, /rm -rf '[^']*\.talea-duplicates'/);
    assert.match(posix.text, /grep -rlF -- '[^']*a[\\/]pw' '[^']+' ~ 2>\/dev\/null/);
  });
});

describe('quoted', () => {
  // A folder name is whatever was on disk, and the line is pasted into a shell:
  // \`$(…)\`, a stray quote or a curly one must stay part of the name.
  const nasty = "/tmp/a$(touch pwned)'b\u2019c\"d";
  test('sh reads it back as the one word it was', { skip: process.platform === 'win32' }, () => {
    assert.equal(execFileSync('sh', ['-c', `printf %s ${quoted(nasty, 'linux')}`], { encoding: 'utf8' }), nasty);
  });
  test('PowerShell gets single quotes with every single-quote character doubled', () => {
    assert.equal(quoted(nasty, 'win32'), "'/tmp/a$(touch pwned)''b\u2019\u2019c\"d'");
  });
});

describe('parseFromPaths', () => {
  test('splits, trims, drops empties and expands ~', () => {
    assert.deepEqual(parseFromPaths(undefined), []);
    assert.deepEqual(parseFromPaths(['a, b', '', ',']), [path.resolve('a'), path.resolve('b')]);
    assert.deepEqual(parseFromPaths('~/x'), [path.join(home, 'x')]);
  });
});
