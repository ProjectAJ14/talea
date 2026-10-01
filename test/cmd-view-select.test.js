// "What does this machine keep?" — src/select.js and `talea select`, driven
// through a fake terminal: a stream standing in for stdin, fed each answer only
// once the prompt that reads it has been drawn.

import assert from 'node:assert/strict';
import test, { describe, before, after, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters as strip } from 'node:util';

// Set before the imports: config.js reads the home directory when it loads.
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-home-')));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
const { chooseRepos, runPicker, selectedRepos } = await import('../src/select.js');
const select = await import('../src/commands/select.js');
const { loadManifest } = await import('../src/config.js');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const saved = {
  stdin: Object.getOwnPropertyDescriptor(process, 'stdin'),
  isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
};

/** A stdin that claims to be a terminal. `failRaw` makes the next setRawMode(true) throw it. */
function terminal({ stdinTTY = true, stdoutTTY = true } = {}) {
  const s = new PassThrough();
  s.isTTY = stdinTTY;
  s.failRaw = null;
  s.setRawMode = (on) => {
    if (on && s.failRaw) {
      const e = s.failRaw;
      s.failRaw = null;
      throw e;
    }
    return s;
  };
  Object.defineProperty(process, 'stdin', { value: s, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true });
  return s;
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', saved.stdin);
  if (saved.isTTY) Object.defineProperty(process.stdout, 'isTTY', saved.isTTY);
  else delete process.stdout.isTTY;
});

/**
 * Run `fn` with output captured and process.exit turned into a return. Each
 * step is [text the prompt prints, what the user types]; the answer is written
 * only once that text has appeared.
 */
async function capture(fn, { stdin, steps = [] } = {}) {
  const out = [];
  const err = [];
  const w = [process.stdout.write, process.stderr.write, process.exit];
  // Strings are the command's output. Buffers are the test runner's own
  // reports, piped through the same stream, and must still reach it.
  const tap = (sink, write, stream) => (s, ...rest) =>
    typeof s === 'string' ? (sink.push(s), true) : write.call(stream, s, ...rest);
  process.stdout.write = tap(out, w[0], process.stdout);
  process.stderr.write = tap(err, w[1], process.stderr);
  process.exit = (code) => {
    throw Object.assign(new Error('exit'), { exitCode: code });
  };
  let from = 0;
  const feeder = setInterval(() => {
    if (!steps.length) return;
    const text = strip(out.join(''));
    const at = text.indexOf(steps[0][0], from);
    if (at < 0) return;
    from = at + steps[0][0].length;
    stdin.write(steps.shift()[1]);
  }, 5);
  let code;
  let value;
  try {
    value = await fn();
  } catch (e) {
    if (!('exitCode' in e)) throw e;
    code = e.exitCode;
  } finally {
    clearInterval(feeder);
    [process.stdout.write, process.stderr.write, process.exit] = w;
  }
  return { out: strip(out.join('')), err: strip(err.join('')), code, value, left: steps.length };
}

const SCOPE = '[1/2]';
const PICKER = 'enter ok';
const BY_LINE = 'Empty = everything.';

let tmp;
let root;
const back = process.cwd();
const stateFile = () => path.join(root, '.talea.json');
const readState = () => JSON.parse(readFileSync(stateFile(), 'utf8'));
const writeState = (s) => writeFileSync(stateFile(), JSON.stringify(s));
const names = (repos) => repos.map((r) => r.name);

before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-select-')));
  root = path.join(tmp, 'ws');
  mkdirSync(root);
  const url = (name) => {
    const bare = path.join(tmp, `${name}.git`);
    git(['init', '-q', '--bare', bare], tmp);
    return bare;
  };
  const catalogue = {
    remotes: {},
    repos: [
      { name: 'alpha', owner: 'me', default: true, url: url('alpha') },
      { name: 'beta', owner: 'me', default: true, url: url('beta') },
      { name: 'gamma', owner: 'me', group: 'tools', url: url('gamma') },
      { name: 'delta', url: url('delta') },
    ],
  };
  writeFileSync(path.join(root, 'talea.repos.json'), JSON.stringify(catalogue));
  writeState({});
  process.chdir(root);
});

after(() => {
  process.chdir(back);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const ctx = (state = {}) => ({ manifest: loadManifest(root), root, state });

describe('chooseRepos', () => {
  test('no terminal takes the defaults and says so, once', async () => {
    terminal({ stdinTTY: false });
    const fresh = await capture(() => chooseRepos(ctx()));
    assert.deepEqual(names(fresh.value.repos), ['alpha', 'beta']);
    assert.equal(fresh.value.asked, false);
    assert.match(fresh.out, /Not a terminal — taking the catalogue's default set \(2 repos\)/);

    terminal({ stdoutTTY: false });
    const chosen = await capture(() => chooseRepos({ ...ctx({ selected: ['gamma'] }), opts: { pick: true } }));
    assert.deepEqual(names(chosen.value.repos), ['gamma']);
    assert.doesNotMatch(chosen.out, /Not a terminal/);
  });

  test('-g/-r and an existing choice never prompt', async () => {
    terminal();
    const narrowed = await capture(() => chooseRepos({ ...ctx(), opts: { group: 'me' } }));
    assert.deepEqual(names(narrowed.value.repos), ['alpha', 'beta']);
    assert.equal(narrowed.value.asked, false);
    const repo = await capture(() => chooseRepos({ ...ctx(), opts: { repo: 'gamma' } }));
    assert.equal(repo.value.asked, false);
    const chosen = await capture(() => chooseRepos({ ...ctx({ selected: [] }), opts: {} }));
    assert.deepEqual(chosen.value, { repos: [], asked: false });
    assert.equal(chosen.out, '');
  });

  test('the default set, taken at the scope question, is written down', async () => {
    const stdin = terminal();
    const r = await capture(() => chooseRepos(ctx({ protocol: 'ssh' })), { stdin, steps: [[SCOPE, '1\n']] });
    assert.equal(r.left, 0);
    assert.match(r.out, /the default set — 2 repos/);
    assert.match(r.out, /choose from all 4 across 3 owners/);
    assert.deepEqual(names(r.value.repos), ['alpha', 'beta']);
    assert.equal(r.value.asked, true);
    assert.deepEqual(readState(), { protocol: 'ssh', selected: ['alpha', 'beta'] });
  });

  test('choosing opens the checklist with the defaults ticked', async () => {
    const stdin = terminal();
    // Toggle the first repo row (alpha) off, then confirm.
    const r = await capture(() => chooseRepos(ctx()), {
      stdin,
      steps: [
        [SCOPE, '2\n'],
        [PICKER, ' \r'],
      ],
    });
    assert.equal(r.left, 0);
    assert.match(r.out, /What should this machine keep\?/);
    assert.deepEqual(names(r.value.repos), ['beta']);
    assert.deepEqual(readState().selected, ['beta']);
  });

  test('cancelling the checklist changes nothing and exits 0', async () => {
    writeState({ selected: ['alpha'] });
    const stdin = terminal();
    const r = await capture(() => chooseRepos({ ...ctx({ selected: ['alpha'] }), opts: { pick: true } }), {
      stdin,
      steps: [[PICKER, 'q']],
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /Cancelled — nothing changed\./);
    assert.deepEqual(readState(), { selected: ['alpha'] });
  });
});

describe('runPicker without raw mode', () => {
  const rows = () => {
    const manifest = loadManifest(root);
    return manifest.repos.map((repo) => ({
      kind: 'repo',
      group: repo.group ?? repo.owner ?? 'repos',
      label: repo.name,
      repo,
      checked: false,
    }));
  };

  test('falls back to typed names; empty means everything', async () => {
    const stdin = terminal();
    stdin.failRaw = Object.assign(new Error('no raw'), { code: 'ERR_TTY_INIT_FAILED' });
    const r = await capture(() => runPicker(rows(), 'pick'), { stdin, steps: [[BY_LINE, '\n']] });
    assert.match(r.out, /could not enter raw mode \(ERR_TTY_INIT_FAILED\)/);
    assert.deepEqual(names(r.value), ['alpha', 'beta', 'gamma', 'delta']);
  });

  test('a group or repo name picks just those', async () => {
    const stdin = terminal();
    stdin.failRaw = new Error('no console');
    const r = await capture(() => runPicker(rows(), 'pick'), { stdin, steps: [[BY_LINE, 'tools, delta\n']] });
    assert.match(r.out, /could not enter raw mode \(no console\)/);
    assert.deepEqual(names(r.value), ['gamma', 'delta']);
  });

  test('an unknown name stops the run, singular or plural', async () => {
    let stdin = terminal();
    stdin.failRaw = new Error('x');
    const one = await capture(() => runPicker(rows(), 'pick'), { stdin, steps: [[BY_LINE, 'bogus\n']] });
    assert.equal(one.code, 1);
    assert.match(one.err, /Unknown name: bogus/);

    stdin = terminal();
    stdin.failRaw = new Error('x');
    const two = await capture(() => runPicker(rows(), 'pick'), { stdin, steps: [[BY_LINE, 'bogus,nope\n']] });
    assert.equal(two.code, 1);
    assert.match(two.err, /Unknown names: bogus, nope/);
  });

  test('selectedRepos is re-exported from the picker', () => {
    assert.equal(typeof selectedRepos, 'function');
  });
});

describe('talea select', () => {
  test('pure helpers: unresolved names and what changed', () => {
    const manifest = loadManifest(root);
    assert.deepEqual(select.unresolved(manifest, ['alpha', 'me/beta', 'nope']), ['nope']);
    assert.deepEqual(select.changes(['a', 'b'], ['b', 'c']), { added: ['c'], dropped: ['a'] });
  });

  test('-g or -r is refused, because the selection is the whole list', async () => {
    terminal({ stdinTTY: false });
    for (const opts of [{ group: 'me' }, { repo: 'alpha' }]) {
      const r = await capture(() => select.run(opts));
      assert.equal(r.code, 1);
      assert.match(r.err, /`select` is about the whole list/);
    }
  });

  test('a name that pins down one repo is `talea add`', async () => {
    writeState({ selected: ['alpha'] });
    terminal({ stdinTTY: false });
    const r = await capture(() => select.run({}, ['ALPHA']));
    assert.match(r.out, /alpha is already on this machine's list/);
    assert.deepEqual(readState().selected, ['alpha']);
  });

  test('a name that matches nothing opens the checklist instead', async () => {
    terminal({ stdinTTY: false });
    const r = await capture(() => select.run({}, ['nope']));
    assert.match(r.out, /No single repo called "nope" — opening the checklist\./);
    assert.match(r.out, /This machine keeps\n\s+1 repos/);
  });

  test('ticking and unticking reports both, and --no-clone clones nothing', async () => {
    writeState({ selected: ['alpha', 'beta'] });
    let stdin = terminal();
    const added = await capture(() => select.run({ clone: false }), { stdin, steps: [[PICKER, 'a\r']] });
    assert.match(added.out, /gamma added/);
    assert.match(added.out, /delta added/);
    assert.match(added.out, /4 repos/);
    assert.equal(existsSync(path.join(root, 'tools', 'gamma')), false);

    stdin = terminal();
    const dropped = await capture(() => select.run({}), { stdin, steps: [[PICKER, 'n\r']] });
    assert.match(dropped.out, /alpha off the list — the checkout stays where it is/);
    assert.doesNotMatch(dropped.out, /added/);
    assert.deepEqual(readState().selected, []);
  });

  test('what is newly ticked is cloned', async () => {
    writeState({ selected: [] });
    const stdin = terminal();
    const r = await capture(() => select.run({ jobs: 1 }), { stdin, steps: [[PICKER, 'j \r']] });
    assert.equal(r.left, 0);
    assert.match(r.out, /beta added/);
    assert.equal(existsSync(path.join(root, 'me', 'beta', '.git')), true);
    process.exitCode = undefined;
  });
});
