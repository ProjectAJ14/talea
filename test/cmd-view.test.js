// The read-only views: `status`, `list`, `tree` and `where`. Real git in a
// temp dir, origins are local bare repos, nothing reaches a network.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { stripVTControlCharacters as strip } from 'node:util';

// Set before the imports: config.js reads the home directory when it loads.
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-home-')));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
const status = await import('../src/commands/status.js');
const list = await import('../src/commands/list.js');
const tree = await import('../src/commands/tree.js');
const where = await import('../src/commands/where.js');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Run `fn` with stdout/stderr captured and process.exit turned into a return. */
async function capture(fn) {
  const out = [];
  const err = [];
  const saved = [process.stdout.write, process.stderr.write, process.exit];
  // Strings are the command's output. Buffers are the test runner's own
  // reports, piped through the same stream, and must still reach it.
  const tap = (sink, write, stream) => (s, ...rest) =>
    typeof s === 'string' ? (sink.push(s), true) : write.call(stream, s, ...rest);
  process.stdout.write = tap(out, saved[0], process.stdout);
  process.stderr.write = tap(err, saved[1], process.stderr);
  process.exit = (code) => {
    throw Object.assign(new Error('exit'), { exitCode: code });
  };
  let code;
  try {
    await fn();
  } catch (e) {
    if (!('exitCode' in e)) throw e;
    code = e.exitCode;
  } finally {
    [process.stdout.write, process.stderr.write, process.exit] = saved;
  }
  return { out: strip(out.join('')), err: strip(err.join('')), code };
}

/** `capture`, with stdin and stderr made terminals and `keys` typed into stdin. */
async function atTerminal(keys, fn, { raw = true } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {
    if (!raw) throw new Error('no raw mode');
  };
  const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
  const errDesc = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  const typing = (async () => {
    for (const k of keys) {
      await new Promise((r) => setTimeout(r, 5));
      input.write(k);
    }
  })();
  try {
    const result = await capture(fn);
    await typing;
    return result;
  } finally {
    Object.defineProperty(process, 'stdin', stdinDesc);
    if (errDesc) Object.defineProperty(process.stderr, 'isTTY', errDesc);
    else delete process.stderr.isTTY;
  }
}

let tmp;
let root;
const back = process.cwd();

const CATALOGUE = {
  remotes: { ssh: 'git@github.com:{owner}/{repo}.git' },
  groups: { me: { dir: 'work/mine' } },
  repos: [
    { name: 'alpha', owner: 'me', defaultBranch: 'main', default: true, private: true },
    { name: 'beta', owner: 'me', defaultBranch: 'main', fork: true },
    { name: 'gamma', owner: 'other', defaultBranch: 'main', missing: true },
    { name: 'delta', owner: 'other' },
    { name: 'broken', owner: 'other', defaultBranch: 'main' },
    { name: 'loose', group: 'misc', archived: true },
    { name: 'spare', owner: 'other', defaultBranch: 'main' },
    { name: 'dusty', owner: 'other', archived: true },
    { name: 'owned', owner: 'other', ignore: true },
    { name: 'dup', owner: 'me' },
    { name: 'dup', owner: 'other' },
  ],
};
const SELECTED = ['alpha', 'beta', 'gamma', 'delta', 'broken', 'loose', 'owned'];

before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-view-')));
  root = path.join(tmp, 'ws');
  mkdirSync(root);
  writeFileSync(path.join(root, 'talea.repos.json'), JSON.stringify(CATALOGUE));
  writeFileSync(path.join(root, '.talea.json'), JSON.stringify({ selected: SELECTED }));

  // alpha: on main, one commit ahead of origin and one behind.
  const origin = path.join(tmp, 'alpha.git');
  git(['init', '-q', '--bare', '-b', 'main', origin], tmp);
  const seed = path.join(tmp, 'seed');
  git(['clone', '-q', origin, seed], tmp);
  for (const d of [seed]) {
    git(['config', 'user.email', 't@example.com'], d);
    git(['config', 'user.name', 't'], d);
  }
  git(['checkout', '-q', '-b', 'main'], seed);
  git(['commit', '-q', '--allow-empty', '-m', 'one'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  const alpha = path.join(root, 'work', 'mine', 'alpha');
  git(['clone', '-q', origin, alpha], tmp);
  git(['config', 'user.email', 't@example.com'], alpha);
  git(['config', 'user.name', 't'], alpha);
  git(['commit', '-q', '--allow-empty', '-m', 'local'], alpha);
  git(['commit', '-q', '--allow-empty', '-m', 'two'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  git(['fetch', '-q'], alpha);

  // beta: dirty, on a feature branch with no upstream.
  const beta = path.join(root, 'work', 'mine', 'beta');
  git(['init', '-q', '-b', 'feature', beta], tmp);
  writeFileSync(path.join(beta, 'CLAUDE.md'), 'doc\n');

  // broken / loose: a `.git` git cannot read, so no branch can be named.
  for (const dir of [path.join(root, 'other', 'broken'), path.join(root, 'misc', 'loose')]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.git'), 'not a gitdir\n');
  }
  process.chdir(root);
});

after(() => {
  process.chdir(back);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('status', () => {
  test('every kept repo, grouped by folder, with branch and state', async () => {
    const { out } = await capture(() => status.run({}));
    assert.match(out, /work\/mine\//);
    assert.match(out, /alpha\s+main\s+clean \S1 \S1/);
    assert.match(out, /beta\s+feature\s+main\s+dirty/);
    assert.match(out, /gamma\s+\S\s+main\s+not cloned/);
    assert.match(out, /delta\s+\S\s+\S\s+not cloned/);
    assert.match(out, /broken\s+\?\s+main\s+clean/);
    assert.match(out, /loose\s+\?\s+clean/);
    assert.doesNotMatch(out, /owned/);
    assert.match(out, /4 cloned, 2 missing, 2 on another branch/);
    assert.match(out, /talea sync/);
  });

  test('--drift and --missing filter the rows, not the counts', async () => {
    const drift = await capture(() => status.run({ drift: true }));
    assert.match(drift.out, /beta/);
    assert.doesNotMatch(drift.out, /alpha|gamma/);
    const missing = await capture(() => status.run({ missing: true }));
    assert.match(missing.out, /gamma/);
    assert.doesNotMatch(missing.out, /alpha|beta/);
  });

  test('one clean repo prints no missing or drift note', async () => {
    const { out } = await capture(() => status.run({ repo: 'alpha' }));
    assert.match(out, /1 cloned\n/);
    assert.doesNotMatch(out, /missing|another branch/);
  });

  test('an empty filter says so', async () => {
    const { out } = await capture(() => status.run({ repo: 'gamma', drift: true }));
    assert.match(out, /Nothing to show\./);
  });

  test('--all reaches past the selection', async () => {
    const { out } = await capture(() => status.run({ all: true }));
    assert.match(out, /spare/);
  });
});

describe('list', () => {
  test('grouped, with keep marks, flags and the quiet count', async () => {
    const { out } = await capture(() => list.run({}));
    assert.match(out, /alpha\s+\S\s+default\s+main\s+private/);
    assert.match(out, /beta\s+\S\s+main\s+fork/);
    assert.match(out, /gamma.*not on github/);
    assert.match(out, /delta\s+\S\s+\?/);
    assert.match(out, /loose.*quiet/);
    assert.match(out, /owned.*ignored/);
    assert.doesNotMatch(out, /dusty/);
    assert.match(out, /, 1 quiet \(--all to show\)/);
  });

  test('--all shows the archived and hides nothing', async () => {
    const { out } = await capture(() => list.run({ all: true }));
    assert.match(out, /dusty/);
    assert.doesNotMatch(out, /--all to show/);
  });

  test('--json is data on stdout', async () => {
    const { out } = await capture(() => list.run({ json: true, repo: 'alpha' }));
    const [row] = JSON.parse(out);
    assert.equal(row.name, 'alpha');
    assert.equal(row.group, 'me');
    assert.equal(row.kept, true);
  });

  test('--groups is the summary only', async () => {
    const { out } = await capture(() => list.run({ groups: true }));
    assert.match(out, /work\/mine\/\s+3\s+2 kept here/);
  });

  test('runs outside a workspace, from the user catalogue, keeping the defaults', async () => {
    const outside = path.join(tmp, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    mkdirSync(path.join(home, '.talea'), { recursive: true });
    writeFileSync(path.join(home, '.talea', 'talea.repos.json'), JSON.stringify(CATALOGUE));
    process.chdir(outside);
    try {
      const { out } = await capture(() => list.run({}));
      assert.match(out, /alpha\s+\S/);
      assert.match(out, /1 kept on this machine/);
    } finally {
      process.chdir(root);
    }
  });
});

describe('tree', () => {
  test('every folder, sorted, and the ones missing a CLAUDE.md counted', async () => {
    const { out } = await capture(() => tree.run({}));
    assert.match(out, /ws\/\s+\S no CLAUDE\.md/);
    assert.match(out, /├─ misc\//);
    assert.match(out, /└─ work\//);
    assert.match(out, /beta\s+\S CLAUDE\.md/);
    assert.match(out, /gamma\s+\S no CLAUDE\.md\s+not cloned/);
    assert.match(out, /5 folders without a CLAUDE\.md/);
  });

  test('one missing doc is singular, none is said plainly', async () => {
    writeFileSync(path.join(root, 'CLAUDE.md'), 'root\n');
    for (const dir of ['work', path.join('work', 'mine')]) {
      writeFileSync(path.join(root, dir, 'CLAUDE.md'), 'group\n');
    }
    const clear = await capture(() => tree.run({ repo: 'beta' }));
    assert.match(clear.out, /every folder has a CLAUDE\.md/);
    const one = await capture(() => tree.run({ repo: 'gamma', all: true }));
    assert.match(one.out, /1 folder without a CLAUDE\.md/);
  });
});

describe('where', () => {
  test('no name prints the root', async () => {
    const { out, code } = await capture(() => where.run({}));
    assert.equal(out, `${root}\n`);
    assert.equal(code, undefined);
  });

  test('a name, any case, or owner/name prints the path alone', async () => {
    const alpha = path.join(root, 'work', 'mine', 'alpha');
    assert.equal((await capture(() => where.run({}, ['ALPHA']))).out, `${alpha}\n`);
    assert.equal((await capture(() => where.run({}, ['me/alpha']))).out, `${alpha}\n`);
  });

  test('not cloned prints the path and still exits non-zero', async () => {
    const { out, err, code } = await capture(() => where.run({}, ['gamma']));
    assert.equal(out, `${path.join(root, 'other', 'gamma')}\n`);
    assert.match(err, /Not cloned yet/);
    assert.equal(code, 1);
  });

  test('a typo fails on stderr, naming catalogue repos that are not cloned', async () => {
    const none = await capture(() => where.run({}, ['zzz']));
    assert.equal(none.out, '');
    assert.equal(none.code, 1);
    assert.doesNotMatch(none.err, /not cloned/);
    const near = await capture(() => where.run({}, ['elt']));
    assert.equal(near.out, '');
    assert.match(near.err, /No repo matching "elt" on this machine/);
    assert.match(near.err, /In the catalogue but not cloned: delta/);
    assert.equal(near.code, 1);
  });

  test('one cloned repo containing the word is the answer', async () => {
    const { out, code } = await capture(() => where.run({}, ['lph']));
    assert.equal(out, `${path.join(root, 'work', 'mine', 'alpha')}\n`);
    assert.equal(code, undefined);
    // With a slash the owner counts too.
    assert.equal((await capture(() => where.run({}, ['me/alp']))).out, `${path.join(root, 'work', 'mine', 'alpha')}\n`);
  });

  test('several matches with no terminal stop and list them, prefix first', async () => {
    const { out, err, code } = await capture(() => where.run({}, ['l']));
    assert.equal(out, '');
    assert.match(err, /"l" matches 2 repos/);
    assert.ok(err.indexOf('loose') < err.indexOf('alpha'));
    assert.equal(code, 1);
    // Two prefix matches fall back to alphabetical.
    const b = await capture(() => where.run({}, ['b']));
    assert.ok(b.err.indexOf('beta') < b.err.indexOf('broken'));
  });

  test('several matches at a terminal open the picker on stderr', async () => {
    const pick = await atTerminal(['j', '\r'], () => where.run({}, ['l']));
    assert.equal(pick.out, `${path.join(root, 'work', 'mine', 'alpha')}\n`);
    assert.match(pick.err, /2 repos match "l"/);
    const cancel = await atTerminal(['q'], () => where.run({}, ['l']));
    assert.equal(cancel.out, '');
    assert.equal(cancel.code, 1);
    // An exact name two owners share is picked from too, not refused.
    const dup = await atTerminal(['\r'], () => where.run({}, ['dup']));
    assert.match(dup.out, /dup\n$/);
    assert.match(dup.err, /Not cloned yet/);
  });

  test('a console with no raw mode falls back to the list', async () => {
    const { out, err, code } = await atTerminal([], () => where.run({}, ['l']), { raw: false });
    assert.equal(out, '');
    assert.match(err, /matches 2 repos/);
    assert.equal(code, 1);
  });

  test('talea cd typed at a terminal says how to make it move the shell', async () => {
    const saved = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      assert.match((await capture(() => where.run({ as: 'cd' }, ['alpha']))).err, /talea shell-init/);
      assert.doesNotMatch((await capture(() => where.run({ as: 'where' }, ['alpha']))).err, /shell-init/);
    } finally {
      if (saved) Object.defineProperty(process.stdout, 'isTTY', saved);
      else delete process.stdout.isTTY;
    }
  });

  test('two owners with one name, and no terminal, is ambiguous, never a pick', async () => {
    const { out, err, code } = await capture(() => where.run({}, ['dup']));
    assert.equal(out, '');
    assert.match(err, /ambiguous — 2 repos/);
    assert.match(err, /talea where me\/dup/);
    assert.equal(code, 1);
  });
});
