// `talea sync` and `talea exec` against real git. Every origin is a local bare
// repo, so nothing reaches a network.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

// Set before the imports: config.js reads home on load, and `run()` records the
// workspace in ~/.talea/state.json — which must not be the developer's own.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const sync = await import('../src/commands/sync.js');
const exec = await import('../src/commands/exec.js');

const git = (args, cwd = tmp) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
let n = 0;
before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-sync-')));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const commit = (dir, file) => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-qm', file], dir);
};

/** A bare origin on `main` with one commit, and a seed clone to push more from. */
function makeOrigin(name) {
  const bare = path.join(tmp, 'origins', String(++n), `${name}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(tmp, 'seeds', String(n), name);
  git(['clone', '-q', bare, seed]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
  commit(seed, 'README.md');
  git(['push', '-q', 'origin', 'main'], seed);
  const advance = (file) => {
    commit(seed, file);
    git(['push', '-q', 'origin', 'main'], seed);
  };
  return { bare, advance };
}

function workspace(repos, state = {}) {
  const ws = path.join(tmp, `ws-${++n}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'talea.repos.json'), JSON.stringify({ repos }));
  writeFileSync(
    path.join(ws, '.talea.json'),
    JSON.stringify({ selected: repos.map((r) => r.name), ...state }),
  );
  return ws;
}

/** Run `fn` from inside `ws`, capturing output and turning process.exit into a throw. */
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

/** The row for one repo in the board's piped output. */
const row = (text, name) =>
  text.split('\n').find((l) => new RegExp(`^\\s*\\S+\\s+${name}\\s`).test(l)) ?? '';

describe('talea sync', () => {
  let ws;
  const origins = {};
  const defaults = { up: 'main', feature: 'main', detached: 'main', diverged: 'main', locked: 'main' };

  before(() => {
    for (const name of [
      'up', 'level', 'ahead', 'feature', 'dirty', 'local', 'detached',
      'diverged', 'locked', 'gone', 'broken', 'missing',
    ]) {
      origins[name] = makeOrigin(name);
    }
    ws = workspace(
      Object.entries(origins).map(([name, o]) => ({
        name,
        owner: 'me',
        url: o.bare,
        ...(defaults[name] ? { defaultBranch: defaults[name] } : {}),
      })),
    );
    const dir = (name) => path.join(ws, 'me', name);
    for (const name of Object.keys(origins)) {
      if (name !== 'missing') git(['clone', '-q', origins[name].bare, dir(name)]);
    }

    origins.up.advance('new.txt');
    commit(dir('ahead'), 'mine.txt');
    git(['checkout', '-q', '-b', 'feat'], dir('feature'));
    git(['push', '-q', '-u', 'origin', 'feat'], dir('feature'));
    writeFileSync(path.join(dir('dirty'), 'scratch.txt'), 'wip\n');
    git(['checkout', '-q', '-b', 'only-here'], dir('local'));
    git(['checkout', '-q', '--detach'], dir('detached'));
    commit(dir('diverged'), 'mine.txt');
    origins.diverged.advance('theirs.txt');
    // A fresh lock is a live git's, so the fast-forward is refused and not stolen.
    origins.locked.advance('new.txt');
    writeFileSync(path.join(dir('locked'), '.git', 'index.lock'), '');
    // git quotes the path in its error, so a folder named after the Azure
    // DevOps "not found" code reads as a remote that is gone.
    git(['remote', 'set-url', 'origin', path.join(tmp, 'TF401019', 'gone.git')], dir('gone'));
    git(['remote', 'set-url', 'origin', path.join(tmp, 'nowhere', 'broken.git')], dir('broken'));
  });

  test('clones the missing, fast-forwards the rest, and says why for every one it did not', async () => {
    const { text, exitCode, error } = await inWs(ws, () => sync.run({}));
    assert.equal(error, null);
    assert.match(text, /Syncing /);
    assert.match(row(text, 'missing'), /→ default/);
    assert.ok(existsSync(path.join(ws, 'me', 'missing', '.git')));
    assert.match(row(text, 'up'), /main updated/);
    assert.match(row(text, 'level'), /main up to date$/);
    assert.match(row(text, 'ahead'), /main up to date ↑1/);
    assert.match(row(text, 'feature'), /feat \(not main\) up to date/);
    assert.match(row(text, 'dirty'), /uncommitted changes on main, fetched only/);
    assert.match(row(text, 'local'), /only-here tracks no remote branch, fetched only/);
    assert.match(row(text, 'detached'), /a detached HEAD tracks no remote branch/);
    assert.match(row(text, 'diverged'), /main — diverged from origin/);
    assert.match(row(text, 'locked'), /main — .*index\.lock/);
    assert.match(row(text, 'gone'), /origin is gone or not granted to you, left as it is/);
    assert.match(row(text, 'broken'), /fetch failed/);
    assert.match(text, /3 repo\(s\) need attention/);
    assert.equal(exitCode, 1);
  });

  test('--no-clone clones nothing and reports the partial run', async () => {
    rmSync(path.join(ws, 'me', 'missing'), { recursive: true, force: true });
    const { text, exitCode } = await inWs(ws, () =>
      sync.run({ clone: false, repo: 'missing,level', jobs: '2', protocol: 'https' }),
    );
    assert.match(text, /to clone\s+0/);
    assert.equal(existsSync(path.join(ws, 'me', 'missing')), false);
    assert.match(text, /1 repo\(s\) were fetched only or left alone/);
    assert.equal(exitCode, 0);
  });

  test('all clear only when every repo is on disk and level', async () => {
    writeFileSync(
      path.join(ws, '.talea.json'),
      JSON.stringify({ selected: Object.keys(origins), protocol: 'https' }),
    );
    const { text, exitCode } = await inWs(ws, () => sync.run({ adopt: false, repo: 'level,missing' }));
    assert.ok(existsSync(path.join(ws, 'me', 'missing', '.git')));
    assert.match(text, /ALL CLEAR/);
    assert.equal(exitCode, 0);
  });

  test('nothing selected says how to choose, and syncs nothing', async () => {
    const empty = workspace([{ name: 'x', owner: 'me', url: origins.level.bare }], { selected: [] });
    const { text, exitCode } = await inWs(empty, () => sync.run({}));
    assert.match(text, /Nothing selected for this machine/);
    assert.equal(existsSync(path.join(empty, 'me')), false);
    assert.equal(exitCode, 0);
  });
});

describe('talea exec', () => {
  let ws;
  before(() => {
    const a = makeOrigin('a');
    const b = makeOrigin('b');
    ws = workspace(
      [
        { name: 'a', owner: 'me', url: a.bare },
        { name: 'b', owner: 'me', url: b.bare },
        { name: 'c', owner: 'me', url: path.join(tmp, 'nowhere', 'c.git') }, // never cloned
      ],
      { selected: ['a'] },
    );
    git(['clone', '-q', a.bare, path.join(ws, 'me', 'a')]);
    git(['clone', '-q', b.bare, path.join(ws, 'me', 'b')]);
    git(['branch', 'only-a'], path.join(ws, 'me', 'a'));
  });

  test('no command exits non-zero before touching the workspace', async () => {
    const { text, error } = await inWs(ws, () => exec.run({}, []));
    assert.match(error.message, /exit 1/);
    assert.match(text, /Nothing to run/);
  });

  test('runs in each cloned repo, and a failure in one fails the run', async () => {
    const { text, exitCode } = await inWs(ws, () =>
      exec.run({ all: true }, ['git', 'rev-parse', '--verify', 'refs/heads/only-a']),
    );
    assert.match(text, /in 2 repos/);
    assert.match(text, /a me[\\/]a\n\s+[0-9a-f]{40}/);
    assert.match(text, /b me[\\/]b \(exit 128\)\n\s+fatal: /);
    assert.match(text, /1 ok/);
    assert.equal(exitCode, 1);
  });

  test('only this machine’s repos by default, and a silent command prints nothing under it', async () => {
    const { text, exitCode } = await inWs(ws, () => exec.run({}, ['git', 'status', '--porcelain']));
    assert.match(text, /in 1 repos/);
    assert.match(text, /a me[\\/]a$/m);
    assert.equal(exitCode, 0);
  });

  test('every argument arrives as typed: spaces, empty, quotes and shell characters', async () => {
    // Found in review: joined and re-split by sh, "two words" arrived as two.
    const args = ['two words', '', 'say "hi"', "it's", '$HOME', 'a;b', 'x|y', '*', '%PATH%', 'back\\slash'];
    const res = await exec.runOne(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], tmp);
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(JSON.parse(res.out), args);
  });

  test('--shell hands the line to the system shell, which interprets it', async () => {
    const res = await exec.runOne('echo', ['one', '&&', 'echo', 'two'], tmp, { shell: true });
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(res.out.split(/\r?\n/).map((l) => l.trim()), ['one', 'two']);
    // Without it, `&&` is an argument like any other.
    const plain = await exec.runOne(process.execPath, ['-e', 'console.log(process.argv[1])', '&&'], tmp);
    assert.equal(plain.out, '&&');
  });

  test('the run shows each argument with its boundaries, and says when a shell reads it', async () => {
    let r = await inWs(ws, () => exec.run({}, [process.execPath, '-e', 'process.stdout.write(process.argv[1])', 'two words']));
    assert.equal(r.exitCode, 0, r.text);
    assert.match(r.text, /-e process\.stdout\.write\(process\.argv\[1\]\) "two words" in 1 repos$/m);
    assert.match(r.text, /^\s+two words$/m);
    r = await inWs(ws, () => exec.run({ shell: true }, ['git rev-parse --is-inside-work-tree && echo shell']));
    assert.match(r.text, /in 1 repos, through the shell/);
    assert.match(r.text, /true\s+shell/);
  });

  test('on Windows a command that will not start names --shell, for .cmd scripts', async () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...desc, value: 'win32' });
    try {
      const res = await exec.runOne('talea-no-such-command', ['install', 'x y'], tmp);
      assert.equal(res.code, -1);
      assert.match(res.out, /on Windows a \.cmd or \.bat script needs --shell: talea exec --shell -- "talea-no-such-command install x y"/);
    } finally {
      Object.defineProperty(process, 'platform', desc);
    }
    // Elsewhere, or with --shell already, the error stands as it is.
    assert.doesNotMatch((await exec.runOne('talea-no-such-command', [], tmp)).out, /--shell/);
  });

  test('a command that cannot start reports -1 instead of hanging', async () => {
    const res = await exec.runOne('git', ['status'], path.join(tmp, 'no-such-dir'));
    assert.equal(res.code, -1);
    assert.ok(res.out, 'the spawn error was not reported');
  });
});
