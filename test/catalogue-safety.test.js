// What a catalogue may say, and where talea will put things because of it.
// A catalogue travels — a gist, a team repo — so every path in it is checked
// before anything is created, moved or written. Real git, local bare origins.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const { catalogueProblems, loadManifest } = await import('../src/config.js');
const { insideRoot } = await import('../src/adopt.js');
const { dropDocs } = await import('../src/docs.js');
const clone = await import('../src/commands/clone.js');
const adopt = await import('../src/commands/adopt.js');

const git = (args, cwd = tmp) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
let n = 0;
before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-safety-')));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeOrigin(name) {
  const bare = path.join(tmp, 'origins', String(++n), `${name}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(tmp, 'seeds', String(n));
  git(['clone', '-q', bare, seed]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
  writeFileSync(path.join(seed, 'README.md'), 'x\n');
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'seed'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  return bare;
}

function workspace(catalogue, state = {}) {
  const ws = path.join(tmp, `ws-${++n}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'talea.repos.json'), JSON.stringify(catalogue));
  writeFileSync(path.join(ws, '.talea.json'), JSON.stringify(state));
  return ws;
}

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
    Object.assign(console, { log: saved.log, error: saved.error });
    process.exit = saved.exit;
    process.chdir(saved.cwd);
    exitCode = process.exitCode ?? 0;
    process.exitCode = 0;
  }
  return { text: stripVTControlCharacters(out.join('\n')), error, exitCode };
}

/** A directory link that needs no privileges: a junction on Windows. */
const link = (target, at) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

describe('catalogueProblems', () => {
  const problems = (catalogue) => catalogueProblems(catalogue);

  test('a usable catalogue has none — nested group dirs, owners, and an ignored twin included', () => {
    assert.deepEqual(
      problems({
        groups: { api: { dir: 'work/api', title: 'API' }, web: {} },
        remotes: { ssh: 'git@github.com:{owner}/{repo}.git' },
        workspace: 'Code/ws',
        repos: [
          { name: 'svc', owner: 'acme', group: 'api', default: true, defaultBranch: 'main', description: null },
          { name: 'svc', owner: 'other', group: 'api', ignore: true },
          { name: 'site', group: 'web', dir: 'site-v2' },
          { name: 'dots' },
        ],
      }),
      [],
    );
    assert.deepEqual(problems({}), []);
  });

  test('every path field that would climb out of the workspace is named, with its entry', () => {
    const found = problems({
      groups: { evil: { dir: '../../x' }, abs: { dir: '/etc' }, drive: { dir: 'C:/Windows' } },
      repos: [
        { name: 'app', owner: 'me', dir: '../../outside/app' },
        { name: '..', owner: 'me' },
        { name: 'a', owner: '..' },
        { name: 'b\\c', owner: 'me' },
        { name: 'd', group: '/srv' },
        { name: 'e', owner: 'me', dir: '' },
        { name: 'f', owner: 'C:evil' },
        { name: `g\0`, owner: 'me' },
        { name: 'h', group: 'evil' },
      ],
    });
    const expect = [
      /^groups\.evil: "dir" has a part that is "\.\."/,
      /^groups\.abs: "dir" is an absolute path/,
      /^groups\.drive: "dir" is an absolute path/,
      /^repos\[0\] \(me\/app\): "dir" has a part that is "\.\.", which names no folder of its own — use a folder below the workspace/,
      /^repos\[1\] \(me\/\.\.\): "name" is "\.\."/,
      /^repos\[2\] \(\.\.\/a\): "owner" is "\.\."/,
      /^repos\[3\] \(me\/b\\c\): "name" holds a slash or backslash/,
      /^repos\[4\] \(d\): "group" is an absolute path/,
      /^repos\[5\] \(me\/e\): "dir" is empty/,
      /^repos\[6\] \(C:evil\/f\): "owner" starts with a drive letter/,
      /^repos\[7\] .*"name" holds a NUL byte/,
    ];
    assert.equal(found.length, expect.length, found.join('\n'));
    expect.forEach((re, i) => assert.match(found[i], re));
  });

  test('an empty name, or an empty part of a path, is named as empty', () => {
    const found = problems({ repos: [{ name: '', owner: 'me' }, { name: 'x', owner: 'me', dir: 'a//b' }] });
    assert.match(found[0], /^repos\[0\] \(me\/\): "name" is empty/);
    assert.match(found[1], /"dir" has a part that is empty/);
  });

  test('a group with no dir of its own is the folder it names, so it is checked as one', () => {
    assert.match(problems({ repos: [{ name: 'x', group: '../up' }] })[0], /"group" has a part that is "\.\."/);
    assert.match(problems({ repos: [{ name: 'x', owner: 'me', group: 5 }] })[0], /"group" is not a string/);
  });

  test('fields of the wrong type are named', () => {
    const found = problems({
      repos: [
        'just a string',
        { owner: 'me' },
        { name: 'a', owner: 7 },
        { name: 'b', default: 'yes', ignore: 1 },
        { name: 'c', url: 5, defaultBranch: [] },
      ],
      groups: { g: 'nope', t: { title: 3 } },
    });
    for (const re of [
      /^repos\[0\]: is not an object/,
      /^repos\[1\]: "name" is missing or not a string/,
      /^repos\[2\] \(a\): "owner" is not a string/,
      /"default" is not true or false — write default: true or leave it out/,
      /"ignore" is not true or false/,
      /"url" is not a string/,
      /"defaultBranch" is not a string/,
      /^groups\.g: "g" is not an object/,
      /^groups\.t: "title" is not a string/,
    ]) {
      assert.ok(found.some((p) => re.test(p)), `missing ${re}\n${found.join('\n')}`);
    }
    for (const bad of [null, [], 'x']) assert.deepEqual(problems(bad), ['the file is not a JSON object']);
    assert.match(problems({ repos: {} })[0], /"repos" is not an array/);
    assert.match(problems({ groups: [] })[0], /"groups" is not an object/);
    assert.match(problems({ remotes: { ssh: 1 } })[0], /"remotes" is not an object of URL templates/);
    assert.match(problems({ workspace: '../elsewhere' })[0], /^the catalogue: "workspace" has a part that is "\.\."/);
  });

  test('two repos talea places in one folder, or one inside another, are a conflict — case ignored', () => {
    const found = problems({
      repos: [
        { name: 'app', owner: 'alice', group: 'work' },
        { name: 'App', owner: 'bob', group: 'work' },
        { name: 'lib', owner: 'carol', group: 'work', dir: 'app/lib' },
        { name: 'app', owner: 'dave', group: 'work', ignore: true },
      ],
    });
    assert.deepEqual(found, [
      'repos[0] (alice/app) and repos[1] (bob/App) both land in work/app — give one of them a "dir" (or "group") of its own',
      'repos[0] (alice/app) and repos[2] (carol/lib) nest one inside the other at work/app — give one of them a "dir" (or "group") of its own',
      'repos[1] (bob/App) and repos[2] (carol/lib) nest one inside the other at work/app — give one of them a "dir" (or "group") of its own',
    ]);
  });
});

describe('a catalogue that fails is refused before anything changes', () => {
  test('loadManifest names the file and every problem, and caps the list', () => {
    const ws = workspace({ repos: Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, owner: '..' })) });
    assert.throws(
      () => loadManifest(ws),
      (err) =>
        err.message.includes(`${path.join(ws, 'talea.repos.json')} is not a usable catalogue:`) &&
        /- repos\[0\] \(\.\.\/r0\): "owner" is "\.\."/.test(err.message) &&
        /… and 2 more/.test(err.message) &&
        /Nothing was changed\. Fix those entries and run the command again\./.test(err.message),
    );
  });

  test('clone and adopt with a dir that climbs out move nothing and create nothing', async () => {
    const origin = makeOrigin('app');
    const ws = workspace({ repos: [{ name: 'app', owner: 'me', url: origin, dir: '../../outside/app' }] }, { selected: ['me/app'] });
    const stray = path.join(ws, 'stray', 'app');
    git(['clone', '-q', origin, stray]);
    const before = readdirSync(path.dirname(path.dirname(ws))).sort();

    for (const run of [() => clone.run({ jobs: 1 }), () => adopt.run({ apply: true })]) {
      const res = await inWs(ws, run);
      assert.match(res.error?.message ?? '', /is not a usable catalogue/);
    }
    assert.equal(existsSync(path.join(stray, '.git')), true, 'the checkout moved');
    assert.deepEqual(readdirSync(path.dirname(path.dirname(ws))).sort(), before, 'something was created outside');
    assert.deepEqual(JSON.parse(readFileSync(path.join(ws, '.talea.json'), 'utf8')), { selected: ['me/app'] });
  });

  test('two repos in one folder stop the run before any clone starts', async () => {
    const ws = workspace(
      {
        repos: [
          { name: 'app', owner: 'alice', group: 'work', url: makeOrigin('app') },
          { name: 'app', owner: 'bob', group: 'work', url: makeOrigin('app') },
        ],
      },
      { selected: ['alice/app', 'bob/app'] },
    );
    const res = await inWs(ws, () => clone.run({ jobs: 2 }));
    assert.match(res.error.message, /both land in work\/app/);
    assert.equal(existsSync(path.join(ws, 'work')), false);
  });
});

describe('a symlink inside the workspace cannot carry anything out of it', () => {
  test('insideRoot follows links above the destination, and the root itself is not inside', () => {
    const root = path.join(tmp, 'root-a');
    const outside = path.join(tmp, 'outside-a');
    mkdirSync(path.join(root, 'real'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    link(outside, path.join(root, 'linked'));
    assert.equal(insideRoot(root, path.join(root, 'real', 'app')), true);
    assert.equal(insideRoot(root, path.join(root, 'not-yet', 'made')), true);
    assert.equal(insideRoot(root, path.join(root, 'linked', 'app')), false);
    assert.equal(insideRoot(root, root), false);
    assert.equal(insideRoot(root, path.join(tmp, '..root-a-sibling')), false);
    // A workspace that is itself a link is fine: both sides are followed.
    const via = path.join(tmp, 'via-link');
    link(root, via);
    assert.equal(insideRoot(via, path.join(via, 'real', 'app')), true);
  });

  test('clone and adopt refuse a destination under a linked folder; the checkout stays put', async () => {
    const origin = makeOrigin('app');
    const ws = workspace({ repos: [{ name: 'app', owner: 'me', url: origin, group: 'work' }] }, { selected: ['me/app'] });
    const outside = path.join(tmp, `outside-${++n}`);
    mkdirSync(outside);
    link(outside, path.join(ws, 'work'));

    let res = await inWs(ws, () => clone.run({ jobs: 1, adopt: false }));
    assert.equal(res.exitCode, 1);
    assert.match(res.text, /work.app leads outside the workspace once symlinks are followed, not cloned/);
    assert.deepEqual(readdirSync(outside), []);

    const stray = path.join(ws, 'stray', 'app');
    git(['clone', '-q', origin, stray]);
    res = await inWs(ws, () => adopt.run({ apply: true }));
    assert.match(res.text, /its destination leads outside the workspace once symlinks are followed — nothing was moved/);
    assert.equal(existsSync(path.join(stray, '.git')), true);
    assert.deepEqual(readdirSync(outside), []);
  });

  test('a second copy is not parked through a linked .talea-duplicates', async () => {
    const origin = makeOrigin('app');
    const ws = workspace({ repos: [{ name: 'app', owner: 'me', url: origin }] }, { selected: ['me/app'] });
    git(['clone', '-q', origin, path.join(ws, 'me', 'app')]);
    const copy = path.join(ws, 'copy', 'app');
    git(['clone', '-q', origin, copy]);
    const outside = path.join(tmp, `outside-${++n}`);
    mkdirSync(outside);
    link(outside, path.join(ws, '.talea-duplicates'));

    const res = await inWs(ws, () => adopt.run({ apply: true }));
    assert.match(res.text, /second copy\n\s+its destination leads outside the workspace/);
    assert.equal(existsSync(path.join(copy, '.git')), true);
    assert.deepEqual(readdirSync(outside), []);
  });

  test('a group doc is not written through a linked folder', () => {
    const root = path.join(tmp, `docs-${++n}`);
    const outside = path.join(tmp, `outside-${++n}`);
    mkdirSync(root);
    mkdirSync(outside);
    link(outside, path.join(root, 'work'));
    const templates = path.join(tmp, `templates-${++n}`);
    mkdirSync(templates);
    writeFileSync(path.join(templates, 'work.CLAUDE.md'), '# work\n');
    assert.throws(() => dropDocs({ groups: {} }, root, ['work'], templates), /leads outside the workspace once symlinks are followed/);
    assert.deepEqual(readdirSync(outside), []);
  });
});
