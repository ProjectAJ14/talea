// `talea clone`, `talea add` / `rm`, and the group docs they drop — against
// real git. Every origin is a local bare repo, so nothing reaches a network.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Set before the imports: config.js reads home on load, and `run()` records the
// workspace in ~/.talea/state.json — which must not be the developer's own.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const clone = await import('../src/commands/clone.js');
const add = await import('../src/commands/add.js');
const { dropDocs, templateFor, TEMPLATES } = await import('../src/docs.js');

const git = (args, cwd = tmp) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
let n = 0;
before(() => {
  // Real path: macOS's tmpdir is a symlink, and git reports paths resolved.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-clone-')));
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

/** A bare origin on `main` with one commit, named `<name>.git` so name matching works. */
function makeOrigin(name) {
  const bare = path.join(tmp, 'origins', String(++n), `${name}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(tmp, 'seeds', String(n), name);
  git(['clone', '-q', bare, seed]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
  commit(seed, 'README.md');
  git(['push', '-q', 'origin', 'main'], seed);
  return bare;
}

/** A catalogue + a state file, every repo selected unless the state says otherwise. */
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

const entry = (name, url, extra = {}) => ({ name, owner: 'me', url, ...extra });
const readState = (ws) => JSON.parse(readFileSync(path.join(ws, '.talea.json'), 'utf8'));

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

describe('talea clone', () => {
  test('every outcome of cloning a missing repo', async () => {
    const corrupt = makeOrigin('d');
    // Drop a blob the history needs: the ref listing still works, so a clone
    // on a missing branch fails as "not found", and the retry fails for real.
    const blob = git(['rev-parse', 'main:README.md'], corrupt);
    const loose = path.join(corrupt, 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(loose, 0o666);
    unlinkSync(loose);

    const iUrl = makeOrigin('i');
    const ws = workspace([
      entry('a', makeOrigin('a'), { defaultBranch: 'main' }),
      entry('b', makeOrigin('b')),
      entry('c', makeOrigin('c'), { defaultBranch: 'master' }),
      entry('d', pathToFileURL(corrupt).href, { defaultBranch: 'master' }),
      // git quotes the path in its error, so a folder named after the Azure
      // DevOps "not found" code reads as a remote that is gone.
      entry('e', path.join(tmp, 'TF401019', 'e.git')),
      entry('f', path.join(tmp, 'nowhere', 'f.git')),
      entry('g', makeOrigin('g')),
      entry('h', makeOrigin('h')),
      entry('i', iUrl, { defaultBranch: 'main' }),
    ]);
    mkdirSync(path.join(ws, 'me', 'g'), { recursive: true });
    writeFileSync(path.join(ws, 'me', 'g', 'notes.txt'), 'mine\n');
    mkdirSync(path.join(ws, 'me', 'h'), { recursive: true }); // empty: fine to clone into
    git(['clone', '-q', iUrl, path.join(ws, 'me', 'i')]); // already cloned: left alone

    const { text, exitCode, error } = await inWs(ws, () => clone.run({}));
    assert.equal(error, null);
    assert.match(text, /Cloning into/);
    assert.match(text, /a\s+→ main me[\\/]a/);
    assert.match(text, /b\s+→ default me[\\/]b/);
    assert.match(text, /cloned on the default branch \(no master on origin\)/);
    assert.equal(git(['branch', '--show-current'], path.join(ws, 'me', 'c')), 'main');
    assert.match(text, /origin is gone or not granted to you, not cloned/);
    assert.match(text, /me[\\/]g already exists and is not a git repo/);
    assert.equal(readFileSync(path.join(ws, 'me', 'g', 'notes.txt'), 'utf8'), 'mine\n');
    assert.ok(existsSync(path.join(ws, 'me', 'h', '.git')));
    assert.match(text, /4 cloned\s+\S+ 3 skipped\s+\S+ 2 failed/);
    assert.match(text, /2 failed/);
    assert.match(text, /Failed clones are usually SSH access/);
    assert.equal(exitCode, 1);
  });

  test('nothing to clone ends at the summary, and --no-adopt skips the search', async () => {
    const p = makeOrigin('p');
    const ws = workspace([entry('p', p)]);
    git(['clone', '-q', p, path.join(ws, 'me', 'p')]);
    const { text, exitCode } = await inWs(ws, () =>
      clone.run({ adopt: false, protocol: 'https', jobs: 2 }),
    );
    assert.doesNotMatch(text, /Existing checkouts/);
    assert.match(text, /1 skipped/);
    assert.equal(exitCode, 0);
  });

  test('checkouts already on disk are moved, parked or left alone — never cloned beside', async () => {
    const x = makeOrigin('x');
    const nm = makeOrigin('n');
    const elsewhere = makeOrigin('n'); // same name, a host the catalogue does not list
    const z = makeOrigin('z');
    const ign = makeOrigin('ign');
    const ws = workspace(
      [
        entry('x', x),
        entry('n', nm),
        entry('z', z),
        entry('ign', ign, { ignore: true }),
      ],
      { protocol: 'https' },
    );
    const away = path.join(tmp, `away-${++n}`);
    git(['clone', '-q', x, path.join(away, 'x')]);
    git(['clone', '-q', x, path.join(ws, 'misc', 'x2')]);
    git(['clone', '-q', x, path.join(ws, 'misc', 'x3')]);
    git(['clone', '-q', elsewhere, path.join(ws, 'misc', 'n')]);
    git(['clone', '-q', z, path.join(ws, 'misc', 'z')]);
    mkdirSync(path.join(ws, 'me', 'z'), { recursive: true });
    writeFileSync(path.join(ws, 'me', 'z', 'keep.txt'), 'x\n');
    git(['clone', '-q', ign, path.join(ws, 'misc', 'ign')]);

    const { text, exitCode } = await inWs(ws, () =>
      clone.run({ repo: 'x,n,z,ign', from: [away] }),
    );
    assert.match(text, /Existing checkouts: 1 to move into place, 2 second copies to park/);
    assert.ok(existsSync(path.join(ws, 'me', 'x', '.git')), 'x was not moved into place');
    assert.ok(existsSync(path.join(ws, '.talea-duplicates', 'me')), 'no second copy was parked');
    assert.match(text, /n left alone — its remote host is not one the catalogue lists/);
    assert.match(text, /z left alone — destination already exists and is not empty/);
    assert.match(text, /Not cloned either/);
    assert.equal(existsSync(path.join(ws, 'me', 'n')), false, 'n was cloned beside its checkout');
    // ignore: true — its checkout is another tool's, so it was not moved.
    assert.ok(existsSync(path.join(ws, 'misc', 'ign', '.git')));
    assert.deepEqual(readState(ws).scanPaths, [away]);
    assert.equal(exitCode, 1);
  });

  test('a move that fails keeps its second copy where it is, and nothing is cloned', async () => {
    const q = makeOrigin('q');
    const ws = workspace([entry('q', q, { group: 'blocked' })], {
      scanPaths: [path.join(tmp, 'remembered')],
    });
    writeFileSync(path.join(ws, 'blocked'), 'a file where the group folder goes\n');
    git(['clone', '-q', q, path.join(ws, 'misc', 'q1')]);
    git(['clone', '-q', q, path.join(ws, 'misc', 'q2')]);
    const extra = path.join(tmp, `extra-${++n}`);

    const { text, exitCode } = await inWs(ws, () => clone.run({ from: extra }));
    assert.match(text, /1 second copy to park/);
    assert.match(text, /second copy left where it is/);
    assert.match(text, /q left alone — its move failed/);
    assert.ok(existsSync(path.join(ws, 'misc', 'q1', '.git')));
    assert.ok(existsSync(path.join(ws, 'misc', 'q2', '.git')));
    assert.deepEqual(readState(ws).scanPaths, [path.join(tmp, 'remembered'), extra]);
    assert.equal(exitCode, 1);
  });

  test('writeDocs names what it wrote, and says nothing when there is nothing new', async () => {
    const templates = path.join(tmp, `templates-${++n}`);
    mkdirSync(templates);
    writeFileSync(path.join(templates, 'me.CLAUDE.md'), '# me\n');
    const ws = path.join(tmp, `docs-${++n}`);
    const manifest = { repos: [], groups: {} };

    const first = await inWs(tmp, () => clone.writeDocs(manifest, ws, [{ name: 'a', owner: 'me' }], templates));
    assert.match(first.text, /Workspace docs/);
    assert.match(first.text, /CLAUDE\.md → me[\\/]CLAUDE\.md/);

    const again = await inWs(tmp, () => clone.writeDocs(manifest, ws, [{ name: 'a', owner: 'me' }], templates));
    assert.equal(again.text, '');
  });

  test('an explicit -r does not clone an `ignore: true` repo (CLAUDE.md rule 4)', async () => {
    const ws = workspace([entry('ign', makeOrigin('ign'), { ignore: true })]);
    const { text, exitCode, error } = await inWs(ws, () => clone.run({ repo: ['ign'] }));
    assert.equal(error, null);
    assert.equal(exitCode, 0);
    assert.match(text, /ign is marked ignore: true/);
    assert.equal(existsSync(path.join(ws, 'me', 'ign')), false);
  });
});

describe('group docs', () => {
  const setup = (files) => {
    const templates = path.join(tmp, `templates-${++n}`);
    mkdirSync(templates);
    for (const f of files) writeFileSync(path.join(templates, `${f}.CLAUDE.md`), `# ${f}\n`);
    return { templates, root: path.join(tmp, `root-${++n}`) };
  };

  test('templateFor is keyed by group, root when there is none, in the packaged folder', () => {
    assert.equal(templateFor('me'), path.join(TEMPLATES, 'me.CLAUDE.md'));
    assert.equal(templateFor(null), path.join(TEMPLATES, 'root.CLAUDE.md'));
  });

  test('root, parent folder and nested group docs are written once, never overwritten', () => {
    const { templates, root } = setup(['root', 'work', 'api']);
    const manifest = { repos: [], groups: { api: { dir: 'work/api' }, web: { dir: 'work/web' } } };

    const first = dropDocs(manifest, root, new Set(['api', 'web']), templates);
    assert.deepEqual(first.written, [
      path.join(root, 'CLAUDE.md'),
      path.join(root, 'work', 'CLAUDE.md'),
      path.join(root, 'work', 'api', 'CLAUDE.md'),
    ]);
    assert.equal(readFileSync(path.join(root, 'work', 'api', 'CLAUDE.md'), 'utf8'), '# api\n');

    writeFileSync(path.join(root, 'CLAUDE.md'), 'my own edits\n');
    const second = dropDocs(manifest, root, new Set(['api']), templates);
    assert.deepEqual(second.written, []);
    assert.equal(second.kept.length, 3);
    assert.equal(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'my own edits\n');
  });

  test('the packaged folder ships nothing, so nothing is written', () => {
    const root = path.join(tmp, `root-${++n}`);
    assert.deepEqual(dropDocs({ repos: [] }, root, new Set(['me'])), { written: [], kept: [] });
    assert.equal(existsSync(root), false);
  });

  test('a group dir that cannot name a folder below the root is refused', () => {
    const { templates, root } = setup(['root']);
    const bad = ['./work/api', '', '.', 'work/../x', 'work//api', '/abs/path'];
    for (const dir of bad) {
      assert.throws(
        () => dropDocs({ groups: { g: { dir } } }, root, new Set(['g']), templates),
        /unusable dir/,
        `accepted ${JSON.stringify(dir)}`,
      );
    }
    // A group with no name at all has no dir either.
    assert.throws(() => dropDocs({}, root, [undefined], templates), /unusable dir undefined/);
    assert.equal(existsSync(root), false, 'wrote before refusing');
  });
});

describe('talea add / rm', () => {
  let ws;
  let url;
  before(() => {
    url = makeOrigin('r');
    const p = makeOrigin('p');
    ws = workspace(
      [
        entry('p', p),
        entry('r', url),
        entry('s', makeOrigin('s')),
        entry('t', makeOrigin('t')),
        entry('bad', path.join(tmp, 'nowhere', 'bad.git')),
        entry('twin', url),
        { name: 'twin', owner: 'you', url: path.join(tmp, 'nowhere', 'twin.git') },
      ],
      { selected: ['p', 's'] },
    );
    git(['clone', '-q', p, path.join(ws, 'me', 'p')]);
  });

  test('lookup matches a name or owner/name, ignoring case', () => {
    const manifest = JSON.parse(readFileSync(path.join(ws, 'talea.repos.json'), 'utf8'));
    assert.equal(add.lookup(manifest, 'TWIN').length, 2);
    assert.deepEqual(add.lookup(manifest, 'You/Twin').map((r) => r.owner), ['you']);
    assert.equal(add.resolve(manifest, 'p').name, 'p');
  });

  test('nothing named, an unknown name and an ambiguous one all exit non-zero', async () => {
    let res = await inWs(ws, () => add.run({}));
    assert.match(res.error.message, /exit 1/);
    assert.match(res.text, /talea add <repo>/);

    res = await inWs(ws, () => add.run({ removing: true }, []));
    assert.match(res.text, /talea rm <repo>/);

    res = await inWs(ws, () => add.run({}, ['nope']));
    assert.match(res.error.message, /exit 1/);
    assert.match(res.text, /No repo called "nope"/);

    res = await inWs(ws, () => add.run({}, ['twin']));
    assert.match(res.error.message, /exit 1/);
    assert.match(res.text, /ambiguous — name the owner too: me\/twin, you\/twin/);
  });

  test('rm takes repos off the list and leaves every checkout where it is', async () => {
    const { text, error } = await inWs(ws, () => add.run({ removing: true }, ['p', 's', 'r']));
    assert.equal(error, null);
    assert.match(text, /p off the list/);
    assert.match(text, /the checkout is still at me[\\/]p/);
    assert.match(text, /s off the list/);
    assert.match(text, /r was not on this machine's list/);
    assert.deepEqual(readState(ws).selected, []);
    assert.ok(existsSync(path.join(ws, 'me', 'p', '.git')));
  });

  test('add of a repo already on disk clones nothing; adding it twice is a no-op', async () => {
    let res = await inWs(ws, () => add.run({}, ['p']));
    assert.match(res.text, /Nothing to clone — already on disk/);
    assert.deepEqual(readState(ws).selected, ['me/p']);

    res = await inWs(ws, () => add.run({}, ['p']));
    assert.match(res.text, /p is already on this machine's list/);
    assert.doesNotMatch(res.text, /Nothing to clone/);
  });

  test('add clones what it added, and a failed clone exits non-zero', async () => {
    let res = await inWs(ws, () => add.run({}, ['bad']));
    assert.match(res.text, /clone failed/);
    assert.equal(res.exitCode, 1);

    writeFileSync(path.join(ws, '.talea.json'), JSON.stringify({ ...readState(ws), protocol: 'https' }));
    res = await inWs(ws, () => add.run({}, ['r']));
    assert.ok(existsSync(path.join(ws, 'me', 'r', '.git')));
    assert.equal(res.exitCode, 0);

    res = await inWs(ws, () => add.run({ protocol: 'ssh', jobs: 1 }, ['t']));
    assert.ok(existsSync(path.join(ws, 'me', 't', '.git')));
    assert.deepEqual(readState(ws).selected, ['me/p', 'me/bad', 'me/r', 'me/t']);
    assert.equal(readState(ws).protocol, 'https');
  });
});
