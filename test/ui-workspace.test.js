// config.js and workspace.js: where the catalogue and state live, and which
// workspace a command means when it is run from outside one.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, afterEach, describe } from 'node:test';

// Set before the imports: config.js reads the home directory when it loads.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-ui-ws-'));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
const config = await import('../src/config.js');
const ws = await import('../src/workspace.js');

const startCwd = process.cwd();
after(() => process.chdir(startCwd));

/** A folder under the temp home, created. */
const dir = (...parts) => {
  const d = path.join(home, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};
const makeWorkspace = (...parts) => {
  const d = dir(...parts);
  writeFileSync(path.join(d, config.STATE_FILE), '{}\n');
  return d;
};
const setUserState = (s) => {
  mkdirSync(config.USER_DIR, { recursive: true });
  writeFileSync(config.USER_STATE, JSON.stringify(s));
};

class Exit extends Error {}

/** Run `fn` with process.exit throwing, and console.error captured. */
async function trapped(fn) {
  const exit = process.exit;
  const error = console.error;
  const errors = [];
  process.exit = (code) => {
    throw Object.assign(new Exit(`exit ${code}`), { code });
  };
  console.error = (...a) => errors.push(a.join(' '));
  try {
    return { result: await fn(), errors };
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    return { code: err.code, errors };
  } finally {
    process.exit = exit;
    console.error = error;
  }
}

/** Swap process.stdin for a PassThrough and make both ends look like terminals. */
async function withTerminal(tty, fn) {
  const input = new PassThrough();
  input.isTTY = tty;
  const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
  const errDesc = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const write = process.stderr.write;
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: tty, configurable: true });
  process.stderr.write = (s, ...rest) => (typeof s === 'string' ? true : write.call(process.stderr, s, ...rest));
  try {
    return await fn(input);
  } finally {
    Object.defineProperty(process, 'stdin', stdinDesc);
    if (errDesc) Object.defineProperty(process.stderr, 'isTTY', errDesc);
    else delete process.stderr.isTTY;
    process.stderr.write = write;
  }
}

describe('config', () => {
  test('user state: missing reads as empty, and a write that cannot land is swallowed', () => {
    assert.deepEqual(config.readUserState(), {});
    config.writeUserState({ a: 1 });
    assert.deepEqual(config.readUserState(), { a: 1 });

    // A state file that cannot be written (here: a folder in its place) must
    // not break the command that tried.
    rmSync(config.USER_STATE);
    mkdirSync(config.USER_STATE);
    assert.doesNotThrow(() => config.writeUserState({ b: 2 }));
    assert.deepEqual(config.readUserState(), {});
    rmSync(config.USER_STATE, { recursive: true });
  });

  test('catalogue: nearest wins, the packaged one is the fallback, and missing keys are filled', () => {
    const root = dir('cat-ws');
    assert.equal(config.loadManifest(root).__source, config.PACKAGED_MANIFEST);
    assert.equal(config.loadManifest(null).__source, config.PACKAGED_MANIFEST);
    assert.deepEqual(config.manifestCandidates(null), [config.USER_MANIFEST, config.PACKAGED_MANIFEST]);

    writeFileSync(path.join(root, config.MANIFEST_NAME), '{}');
    const m = config.loadManifest(root);
    assert.equal(m.__source, path.join(root, config.MANIFEST_NAME));
    assert.deepEqual([m.repos, m.groups], [[], {}]);
  });

  test('saveManifest: explicit file, back to its source, packaged goes to the user one', () => {
    const root = dir('save-ws');
    const explicit = path.join(root, 'x.json');
    assert.equal(config.saveManifest({ repos: [], __source: 'ignored' }, explicit), explicit);
    assert.deepEqual(JSON.parse(readFileSync(explicit, 'utf8')), { repos: [] });

    assert.equal(config.saveManifest({ repos: [], __source: explicit }), explicit);
    assert.equal(config.saveManifest({ repos: [], __source: config.PACKAGED_MANIFEST }), config.USER_MANIFEST);
    assert.equal(config.saveManifest({ repos: [] }), config.USER_MANIFEST);
    // The user catalogue now exists, so it wins over the packaged one.
    assert.equal(config.loadManifest(null).__source, config.USER_MANIFEST);
  });

  test('findWorkspace walks up to the nearest .talea.json, or gives up at the root', () => {
    const root = makeWorkspace('walk-ws');
    const deep = dir('walk-ws', 'a', 'b');
    assert.equal(config.findWorkspace(deep), root);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'talea-none-'));
    assert.equal(config.findWorkspace(outside), null);
    process.chdir(deep);
    // The cwd comes back resolved (/var is /private/var on macOS).
    assert.equal(realpathSync(config.findWorkspace()), realpathSync(root));
    process.chdir(startCwd);
  });

  test('workspace state round-trips, and a missing file is empty', () => {
    const root = dir('state-ws');
    assert.deepEqual(config.loadState(root), {});
    config.saveState(root, { selected: ['a'] });
    assert.deepEqual(config.loadState(root), { selected: ['a'] });
  });

  test('expandHome handles ~, ~/, ~\\ and leaves everything else alone', () => {
    assert.equal(config.expandHome('~'), home);
    assert.equal(config.expandHome('~/w'), path.join(home, 'w'));
    assert.equal(config.expandHome('~\\w'), path.join(home, 'w'));
    assert.equal(config.expandHome('/abs'), '/abs');
  });

  test('repoUrl: override, template, and an unknown protocol with or without remotes', () => {
    const m = { remotes: { ssh: 'git@h:{owner}/{repo}.git' } };
    assert.equal(config.repoUrl(m, { name: 'r', url: 'u' }), 'u');
    assert.equal(config.repoUrl(m, { name: 'r', owner: 'o' }), 'git@h:o/r.git');
    assert.equal(config.repoUrl(m, { name: 'r' }), 'git@h:/r.git');
    assert.throws(() => config.repoUrl(m, { name: 'r' }, 'https'), /Known: ssh/);
    assert.throws(() => config.repoUrl({}, { name: 'r' }), /Known: $/);
  });

  test('groups, dirs and branches', () => {
    const m = { groups: { g: { dir: 'nested/g' } } };
    assert.equal(config.groupDir(m, 'g'), 'nested/g');
    assert.equal(config.groupDir({}, 'x'), 'x');
    assert.equal(config.repoGroup({}), 'repos');
    assert.equal(config.repoGroup({ owner: 'o' }), 'o');
    assert.equal(config.repoDir(m, '/w', { name: 'n', group: 'g', dir: 'd' }), path.join('/w', 'nested/g', 'd'));
    assert.equal(config.defaultBranch({ defaultBranch: 'trunk' }), 'trunk');
    assert.equal(config.defaultBranch({}), null);
  });
});

describe('requireWorkspace', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'talea-out-'));
  afterEach(() => process.chdir(startCwd));

  test('inside one: the walk wins, and the workspace is remembered', async () => {
    setUserState({});
    const root = makeWorkspace('inside-ws');
    process.chdir(root);
    const { root: got, manifest, state } = await ws.requireWorkspace();
    assert.ok(ws.workspaceCandidates().some((d) => path.basename(d) === 'inside-ws'));
    assert.equal(path.basename(got), 'inside-ws');
    assert.ok(Array.isArray(manifest.repos));
    assert.deepEqual(state, {});
  });

  test('outside, with none known: stops with a hint', async () => {
    setUserState({});
    process.chdir(outside);
    const { code, errors } = await trapped(() => ws.requireWorkspace());
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /talea init/);
  });

  test('outside, with one known: uses it and says so on stderr', async () => {
    const only = makeWorkspace('only-ws');
    setUserState({ workspaces: [only] });
    process.chdir(outside);
    const { result, errors } = await trapped(() => ws.requireWorkspace());
    assert.equal(result.root, only);
    assert.match(errors.join('\n'), /Using the workspace at/);
  });

  test('outside, with several and no terminal: stops rather than picks', async () => {
    const a = makeWorkspace('many-a');
    const b = makeWorkspace('many-b');
    setUserState({ workspaces: [a, b] });
    process.chdir(outside);
    const { code, errors } = await withTerminal(false, () => trapped(() => ws.requireWorkspace()));
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /this machine has 2/);
  });

  test('outside, with several on a terminal: asks, and takes a valid answer', async () => {
    const a = makeWorkspace('many-a');
    const b = makeWorkspace('many-b');
    setUserState({ workspaces: [a, b] });
    process.chdir(outside);
    const { result } = await withTerminal(true, (input) => {
      setImmediate(() => input.write('2\n'));
      return trapped(() => ws.requireWorkspace());
    });
    assert.equal(result.root, b);
  });

  test('outside, with several on a terminal: a wrong answer stops', async () => {
    const a = makeWorkspace('many-a');
    const b = makeWorkspace('many-b');
    for (const answer of ['9', 'x']) {
      setUserState({ workspaces: [a, b] });
      process.chdir(outside);
      const { code, errors } = await withTerminal(true, (input) => {
        setImmediate(() => input.write(`${answer}\n`));
        return trapped(() => ws.requireWorkspace());
      });
      assert.equal(code, 1);
      assert.match(errors.join('\n'), new RegExp(`"${answer}" is not one of 1-2`));
    }
  });
});

describe('selection', () => {
  const manifest = {
    repos: [
      { name: 'api', group: 'work', default: true },
      { name: 'old', group: 'work', default: true, archived: true },
      { name: 'dots', owner: 'me' },
      { name: 'vendored', owner: 'me', default: true, ignore: true },
    ],
  };
  const names = (repos) => repos.map((r) => r.name);

  test('machineRepos, adoptable and hasChosen', () => {
    assert.deepEqual(names(ws.machineRepos(manifest, {})), ['api']);
    assert.deepEqual(names(ws.machineRepos(manifest, { selected: ['DOTS', 'vendored'] })), ['dots']);
    assert.deepEqual(names(ws.adoptable(manifest)), ['api', 'old', 'dots']);
    assert.equal(ws.hasChosen({}), false);
    assert.equal(ws.hasChosen({ selected: [] }), true);
  });

  test('selectRepos filters by group and name, flattening csv and arrays', async () => {
    // Never an ignored one, whatever the pool — unless a view asks for it.
    assert.deepEqual(names(ws.selectRepos(manifest)), ['api', 'old', 'dots']);
    assert.deepEqual(names(ws.selectRepos(manifest, {}, manifest.repos, { includeIgnored: true })), names(manifest.repos));
    assert.deepEqual(names(ws.selectRepos(manifest, { group: 'WORK' })), ['api', 'old']);
    assert.deepEqual(names(ws.selectRepos(manifest, { group: ['me', ''], repo: 'dots, api' })), ['dots']);
    // -r reaches past the pool; without it the pool is what is filtered.
    const pool = [manifest.repos[0]];
    assert.deepEqual(names(ws.selectRepos(manifest, { repo: ['old'] }, pool)), ['old']);
    assert.deepEqual(names(ws.selectRepos(manifest, {}, pool)), ['api']);
  });

  test('-r never reaches an ignored repo (rule 4), but says so rather than calling it a typo', async () => {
    const { result, code, errors } = await trapped(() => ws.selectRepos(manifest, { repo: 'vendored,api' }, []));
    assert.equal(code, undefined);
    assert.deepEqual(names(result), ['api']);
    assert.match(errors.join('\n'), /vendored is marked ignore: true/);
    // A pool that already holds it — `exec --all`, a picker result — still does not.
    const all = await trapped(() => ws.selectRepos(manifest, { repo: 'vendored' }, manifest.repos));
    assert.deepEqual(names(all.result), []);
    assert.match(all.errors.join('\n'), /vendored is marked ignore: true/);
    // A view of the catalogue that holds it keeps it, quietly.
    const listed = await trapped(() => ws.selectRepos(manifest, { repo: 'vendored' }, manifest.repos, { includeIgnored: true }));
    assert.deepEqual(names(listed.result), ['vendored']);
    assert.deepEqual(listed.errors, []);
  });

  test('selectRepos stops on an unknown group or repo', async () => {
    const g = await trapped(() => ws.selectRepos(manifest, { group: 'nope' }));
    assert.equal(g.code, 1);
    assert.match(g.errors.join('\n'), /Unknown group "nope"[\s\S]*Known groups: work, me/);
    const r = await trapped(() => ws.selectRepos(manifest, { repo: 'nope' }));
    assert.equal(r.code, 1);
    assert.match(r.errors.join('\n'), /Unknown repo "nope"/);
  });

  test('withPaths marks what is cloned, clonedOnly keeps only that', () => {
    const root = dir('paths-ws');
    dir('paths-ws', 'work', 'api', '.git');
    const entries = ws.withPaths(manifest, root, manifest.repos.slice(0, 2));
    assert.deepEqual(entries.map((e) => e.cloned), [true, false]);
    assert.deepEqual(names(ws.clonedOnly(entries).map((e) => e.repo)), ['api']);
  });

  test('requireCatalogue passes a filled catalogue and stops an empty one', async () => {
    assert.equal(ws.requireCatalogue(manifest), undefined);
    const { code, errors } = await trapped(() => ws.requireCatalogue({ repos: [] }));
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /talea discover/);
  });
});

// Last: it creates ~/Workspace, which every "outside" case above must not see.
test('the default ~/Workspace is a candidate, and a workspace is remembered once', () => {
  setUserState({});
  const root = makeWorkspace('Workspace');
  ws.rememberWorkspace(root);
  ws.rememberWorkspace(root);
  assert.deepEqual(config.readUserState().workspaces, [root]);
  assert.deepEqual(ws.workspaceCandidates(), [root]);
});

// A state.json holding `null` parses fine, and every caller that reads a field
// off it would throw — `knownWorkspaces()`, `rememberWorkspace()`, and
// autoUpdateAsync, which promises never to throw.
test('a state.json that is valid JSON but not an object reads as empty', () => {
  for (const text of ['null', '[]', '3']) {
    writeFileSync(config.USER_STATE, text);
    assert.deepEqual(config.readUserState(), {});
  }
  assert.doesNotThrow(() => ws.workspaceCandidates());
});
