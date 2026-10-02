// GitHub, discover and manifest — with no network. `gh` is replaced through
// the `io` seam in src/github.js and `fetch` is stubbed on globalThis, so
// nothing here can reach api.github.com or depend on the machine having `gh`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

// config.js reads the home directory at load, and findWorkspace walks up from
// the cwd — which, from this checkout, would find the developer's real workspace.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'talea-net-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.NO_COLOR = '1';
process.env.TALEA_NO_UPDATE_CHECK = '1';
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
process.chdir(HOME);

const gh = await import('../src/github.js');
const discover = await import('../src/commands/discover.js');
const manifest = await import('../src/commands/manifest.js');
const { USER_MANIFEST, USER_STATE, readUserState } = await import('../src/config.js');

const realFetch = globalThis.fetch;
const realSpawn = gh.io.spawnSync;

class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** Run `fn` with console and process.exit captured. */
async function capture(fn) {
  const out = [];
  const err = [];
  const { log, error } = console;
  const exit = process.exit;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exit = (code) => {
    throw new Exit(code);
  };
  let code = null;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
  return { out: out.join('\n'), err: err.join('\n'), exit: code };
}

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/** fetch stub: `routes` maps a URL substring to a Response factory; calls are recorded. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return routes[key](url, init);
  };
  return calls;
}

/** `gh` stub: `handler(args, opts)` returns a spawnSync-shaped result. */
function stubGh(handler) {
  const calls = [];
  gh.io.spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return handler(args, opts);
  };
  return calls;
}

const noGh = () => {
  gh.io.gh = false;
  stubGh(() => ({ status: 1, stdout: '', stderr: 'not found' }));
};

beforeEach(() => {
  gh.io.gh = null;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  gh.io.spawnSync = realSpawn;
  gh.io.gh = null;
  process.exitCode = undefined;
  rmSync(path.join(HOME, '.talea'), { recursive: true, force: true });
});

// ── src/github.js ────────────────────────────────────────────────

describe('token()', () => {
  test('prefers GITHUB_TOKEN, then GH_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'a';
    process.env.GH_TOKEN = 'b';
    assert.deepEqual(gh.token(), { token: 'a', from: 'GITHUB_TOKEN' });
    delete process.env.GITHUB_TOKEN;
    assert.deepEqual(gh.token(), { token: 'b', from: 'GH_TOKEN' });
  });

  test('falls back to `gh auth token`, and to nothing', () => {
    let result = { status: 0, stdout: ' tok\n' };
    const calls = stubGh(() => result);
    assert.deepEqual(gh.token(), { token: 'tok', from: 'gh auth token' });
    assert.deepEqual(calls[0].args, ['auth', 'token']);
    assert.equal(calls[0].opts.shell, false);

    result = { status: 0, stdout: '  \n' }; // logged out prints nothing
    assert.deepEqual(gh.token(), { token: null, from: null });
    result = { status: 1, stdout: 'x' };
    assert.deepEqual(gh.token(), { token: null, from: null });
    result = { status: null, stdout: null, error: new Error('ENOENT') }; // no gh at all
    assert.deepEqual(gh.token(), { token: null, from: null });
  });
});

test('haveGh() asks once and remembers', () => {
  const calls = stubGh(() => ({ status: 0 }));
  assert.equal(gh.haveGh(), true);
  assert.equal(gh.haveGh(), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--version']);
});

describe('through gh', () => {
  beforeEach(() => {
    gh.io.gh = true;
  });

  test('paginates with --slurp and flattens the pages', async () => {
    const calls = stubGh(() => ({ status: 0, stdout: JSON.stringify([[{ name: 'a' }], [{ name: 'b' }]]) }));
    const repos = await gh.listRepos({ token: 't' });
    assert.deepEqual(repos.map((r) => r.name), ['a', 'b']);
    const { args, opts } = calls[0];
    assert.equal(args[0], 'api');
    assert.match(args[1], /^\/user\/repos\?/);
    assert.ok(args.includes('--paginate') && args.includes('--slurp'));
    assert.equal(opts.input, undefined);
  });

  test('sends a body on stdin', async () => {
    const calls = stubGh(() => ({ status: 0, stdout: '{"id":"g1"}' }));
    assert.equal(await gh.createGist({ token: 't', filename: 'f', content: 'c', description: 'd' }), 'g1');
    const { args, opts } = calls[0];
    assert.deepEqual(args.slice(0, 4), ['api', '/gists', '-X', 'POST']);
    assert.deepEqual(args.slice(-2), ['--input', '-']);
    assert.deepEqual(JSON.parse(opts.input), { description: 'd', public: false, files: { f: { content: 'c' } } });
  });

  test('reads one object without paginating', async () => {
    stubGh(() => ({ status: 0, stdout: '{"login":"me"}' }));
    assert.equal(await gh.whoami('t'), 'me');
  });

  test('reports the first line of gh stderr', async () => {
    stubGh(() => ({ status: 1, stderr: 'HTTP 404: Not Found\nsecond line' }));
    await assert.rejects(gh.whoami('t'), { message: 'GitHub — HTTP 404: Not Found' });
    stubGh(() => ({ status: 1, stderr: null }));
    await assert.rejects(gh.whoami('t'), /^Error: GitHub — /);
  });

  // A `??` fallback here never fired — split() always yields a string — so an
  // empty stderr used to give "GitHub — " and nothing else.
  test('names the exit code when gh prints nothing', async () => {
    stubGh(() => ({ status: 4, stderr: '' }));
    await assert.rejects(gh.whoami('t'), /exited 4/);
  });
});

describe('through fetch', () => {
  beforeEach(noGh);

  test('follows Link rel="next" and sends the token', async () => {
    const calls = stubFetch({
      'page=2': () => json([{ name: 'b' }], { headers: { link: '<https://api.github.com/x?page=1>; rel="prev"' } }),
      '/user/repos': () => json([{ name: 'a' }], { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } }),
    });
    const repos = await gh.listRepos({ token: 'tok' });
    assert.deepEqual(repos.map((r) => r.name), ['a', 'b']);
    assert.equal(calls[0].url.startsWith('https://api.github.com/user/repos?'), true);
    assert.equal(calls[1].url, 'https://api.github.com/user/repos?page=2');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
    assert.equal(calls[0].init.headers['content-type'], undefined);
  });

  test('public repos of a user need no token', async () => {
    const calls = stubFetch({ '/users/some%20one/repos': () => json([{ name: 'p' }]) });
    assert.deepEqual(await gh.listRepos({ token: null, user: 'some one' }), [{ name: 'p' }]);
    assert.equal(calls[0].init.headers.authorization, undefined);
  });

  test('no token and no user is an error that says what to do', async () => {
    await assert.rejects(gh.listRepos({ token: null }), /--user <login>/);
  });

  test('errors carry the status and the message', async () => {
    stubFetch({ '/user': () => json({ message: 'Bad credentials' }, { status: 401 }) });
    await assert.rejects(gh.whoami('t'), { message: 'GitHub 401 on /user — Bad credentials' });

    stubFetch({ '/user': () => json({}, { status: 403 }) }); // JSON with no message
    await assert.rejects(gh.whoami('t'), { message: 'GitHub 403 on /user' });

    stubFetch({ '/user': () => new Response('x'.repeat(300), { status: 502 }) });
    await assert.rejects(gh.whoami('t'), { message: `GitHub 502 on /user — ${'x'.repeat(200)}` });

    stubFetch({ '/user': () => ({ ok: false, status: 500, text: () => Promise.reject(new Error('reset')) }) });
    await assert.rejects(gh.whoami('t'), { message: 'GitHub 500 on /user' });
  });

  test('gists: create, update, and a body with its content type', async () => {
    const calls = stubFetch({ '/gists': (url, init) => json({ id: init.method === 'POST' ? 'new' : 'old' }) });
    assert.equal(await gh.createGist({ token: 't', filename: 'f', content: 'c', description: 'd' }), 'new');
    assert.equal(await gh.updateGist({ token: 't', id: 'old', filename: 'f', content: 'c2' }), 'old');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.equal(calls[1].url, 'https://api.github.com/gists/old');
    assert.deepEqual(JSON.parse(calls[1].init.body), { files: { f: { content: 'c2' } } });
  });

  test('readGist: the named file, else the first, else an error', async () => {
    let body;
    stubFetch({ '/gists/': () => json(body) });
    body = { files: { 'talea.repos.json': { content: 'named' }, other: { content: 'o' } } };
    assert.equal(await gh.readGist({ token: 't', id: 'g', filename: 'talea.repos.json' }), 'named');
    body = { files: { other: { content: 'first' } } };
    assert.equal(await gh.readGist({ token: 't', id: 'g', filename: 'talea.repos.json' }), 'first');
    body = {};
    await assert.rejects(gh.readGist({ token: 't', id: 'g', filename: 'x' }), /Gist g has no files/);
  });

  test('readGist: a truncated file is fetched whole from raw_url', async () => {
    let raw = () => new Response('full text');
    stubFetch({
      'raw.example': () => raw(),
      '/gists/': () => json({ files: { f: { truncated: true, raw_url: 'https://raw.example/f', content: 'half' } } }),
    });
    assert.equal(await gh.readGist({ token: 't', id: 'g', filename: 'f' }), 'full text');
    raw = () => new Response('', { status: 500 });
    await assert.rejects(gh.readGist({ token: 't', id: 'g', filename: 'f' }), /Could not read the full gist \(500\)/);
  });
});

describe('toEntry()', () => {
  test('maps a full API repo', () => {
    const e = gh.toEntry({
      name: 'r',
      owner: { login: 'o' },
      default_branch: 'dev',
      private: 1,
      fork: 1,
      parent: { full_name: 'up/r' },
      pushed_at: '2026-01-01T00:00:00Z',
      archived: true,
      description: 'd',
    });
    assert.deepEqual(e, {
      name: 'r',
      owner: 'o',
      defaultBranch: 'dev',
      private: true,
      fork: true,
      upstream: 'up/r',
      pushedAt: '2026-01-01T00:00:00Z',
      archived: true,
      description: 'd',
    });
  });

  test('fills the gaps honestly, and ages by activeSince', () => {
    const bare = gh.toEntry({ name: 'r' });
    assert.equal(bare.owner, undefined);
    assert.equal(bare.defaultBranch, null);
    assert.equal(bare.upstream, null);
    assert.equal(bare.pushedAt, null);
    assert.equal(bare.archived, false);
    assert.equal(bare.description, '');
    // Never pushed sorts before any window, so it reads as quiet.
    assert.equal(gh.toEntry({ name: 'r' }, { activeSince: '2026-01-01' }).archived, true);
    assert.equal(gh.toEntry({ name: 'r', pushed_at: '2026-06-01' }, { activeSince: '2026-01-01' }).archived, false);
  });
});

// ── src/commands/discover.js ─────────────────────────────────────

describe('parseSince()', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  test('reads every unit', () => {
    assert.equal(discover.parseSince(null), null);
    assert.equal(discover.parseSince('10d', now), '2026-06-05T00:00:00.000Z');
    assert.equal(discover.parseSince('2w', now), '2026-06-01T00:00:00.000Z');
    assert.equal(discover.parseSince('1y', now), '2025-06-15T00:00:00.000Z');
    // Month steps that cross no DST change in either hemisphere, so local time cannot shift them.
    assert.equal(discover.parseSince('12mo', now), '2025-06-15T00:00:00.000Z');
    assert.equal(discover.parseSince('1M', now), '2026-05-15T00:00:00.000Z');
    assert.equal(discover.parseSince('2026-01-01'), '2026-01-01T00:00:00.000Z');
    assert.ok(discover.parseSince('1d')); // default `now`
  });
  test('refuses what it cannot read', () => {
    assert.throws(() => discover.parseSince('6x'), /Cannot read --since "6x"/);
  });
});

test('merge() keeps every choice and marks what vanished', () => {
  const existing = [
    { owner: 'O', name: 'Kept', default: false, group: 'g', dir: 'd', url: 'u', ignore: true },
    { owner: 'o', name: 'plain' },
    { owner: 'o', name: 'gone' },
  ];
  const found = [
    { owner: 'o', name: 'kept', defaultBranch: 'main' },
    { owner: 'o', name: 'plain', defaultBranch: 'dev' },
    { owner: 'o', name: 'new' },
  ];
  const { repos, added, vanished } = discover.merge(existing, found);
  assert.deepEqual(repos[0], {
    owner: 'o',
    name: 'kept',
    defaultBranch: 'main',
    default: false,
    group: 'g',
    dir: 'd',
    url: 'u',
    ignore: true,
  });
  assert.deepEqual(repos[1], { owner: 'o', name: 'plain', defaultBranch: 'dev' });
  assert.deepEqual(added.map((r) => r.name), ['new']);
  assert.deepEqual(vanished.map((r) => r.name), ['gone']);
  assert.deepEqual(repos[3], { owner: 'o', name: 'gone', missing: true });
});

describe('talea discover', () => {
  beforeEach(noGh);

  const api = (n, extra = {}) => ({
    name: `r${n}`,
    owner: { login: 'me' },
    pushed_at: '2026-05-01T00:00:00Z',
    ...extra,
  });

  test('a dry run with a token says who, and writes nothing', async () => {
    process.env.GITHUB_TOKEN = 't';
    stubFetch({
      '/user/repos': () => json([api(1), api(2, { pushed_at: undefined })]),
      '/user': () => json({ login: 'me' }),
    });
    const r = await capture(() => discover.run({ since: '2026-01-01' }));
    assert.equal(r.exit, null);
    assert.match(r.out, /GITHUB_TOKEN/);
    assert.match(r.out, /signed in as me/);
    assert.match(r.out, /active since\s+2026-01-01/);
    assert.match(r.out, /\+ me\/r1 2026-05-01/);
    assert.match(r.out, /Re-run with --apply/);
    assert.equal(existsSync(USER_MANIFEST), false);
  });

  test('a token whose account cannot be read still lists', async () => {
    process.env.GITHUB_TOKEN = 't';
    stubFetch({
      '/user/repos': () => json([api(1)]),
      '/user': () => json({ message: 'nope' }, { status: 401 }),
    });
    const r = await capture(() => discover.run({}));
    assert.match(r.out, /Could not read the account behind that token — GitHub 401/);
    assert.match(r.out, /\+ me\/r1/);
  });

  test('--apply seeds defaults, then a second run keeps choices and marks the missing', async () => {
    const many = Array.from({ length: 42 }, (_, i) => api(i));
    many.push(api(90, { fork: true }), api(91, { archived: true }), api(92, { owner: { login: 'org' } }));
    let list = many;
    const calls = stubFetch({ '/users/me/repos': () => json(list) });

    const first = await capture(() => discover.run({ user: 'me', apply: true }));
    assert.match(first.out, /none — public repos only/);
    assert.match(first.out, /user\s+me/);
    assert.match(first.out, /… and 5 more/);
    assert.match(first.out, /catalogue written/);
    assert.match(first.out, /43 repos marked default/); // 42 plain + the org one; not the fork or the archived
    assert.equal(calls[0].init.headers.authorization, undefined);

    const saved = JSON.parse(readFileSync(USER_MANIFEST, 'utf8'));
    assert.equal(saved.repos.find((r) => r.name === 'r90').default, false);
    assert.equal(saved.repos.find((r) => r.name === 'r91').default, false);
    assert.deepEqual(saved.groups.me, { dir: 'me', title: 'me on GitHub' });

    // Your edits, which a rerun must not undo.
    saved.groups.me = { dir: 'mine', title: 'Mine' };
    saved.repos.find((r) => r.name === 'r1').default = false;
    writeFileSync(USER_MANIFEST, JSON.stringify(saved));

    list = many.filter((r) => r.name !== 'r0');
    const second = await capture(() => discover.run({ user: 'me', apply: true }));
    assert.match(second.out, /In the catalogue, not returned by GitHub/);
    assert.match(second.out, /\? me\/r0/);
    assert.doesNotMatch(second.out, /marked default/);
    const again = JSON.parse(readFileSync(USER_MANIFEST, 'utf8'));
    assert.deepEqual(again.groups.me, { dir: 'mine', title: 'Mine' });
    assert.equal(again.repos.find((r) => r.name === 'r1').default, false);
    assert.equal(again.repos.find((r) => r.name === 'r0').missing, true);
  });

  test('--user with a token skips whoami and lists the public repos', async () => {
    process.env.GITHUB_TOKEN = 't';
    const calls = stubFetch({ '/users/other/repos': () => json([]) });
    const r = await capture(() => discover.run({ user: 'other' }));
    assert.equal(r.exit, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.authorization, undefined);
  });

  test('no token and no user exits non-zero', async () => {
    const r = await capture(() => discover.run({}));
    assert.equal(r.exit, 1);
    assert.match(r.err, /No GitHub token, and no --user/);
  });
});

// ── src/commands/manifest.js ─────────────────────────────────────

describe('talea manifest', () => {
  beforeEach(noGh);

  const catalogue = (repos = [{ owner: 'o', name: 'r' }]) => {
    mkdirSync(path.dirname(USER_MANIFEST), { recursive: true });
    writeFileSync(USER_MANIFEST, JSON.stringify({ repos }));
  };

  test('push and pull need a token', async () => {
    for (const verb of ['push', 'pull']) {
      const r = await capture(() => manifest.run({}, [verb]));
      assert.equal(r.exit, 1);
      assert.match(r.err, /A GitHub token is needed/);
    }
  });

  test('push refuses an empty catalogue', async () => {
    process.env.GITHUB_TOKEN = 't';
    const r = await capture(() => manifest.run({}, ['push']));
    assert.equal(r.exit, 1);
    assert.match(r.err, /The catalogue is empty/);
  });

  test('push creates a gist once, then updates the remembered one byte for byte', async () => {
    process.env.GITHUB_TOKEN = 't';
    catalogue();
    const calls = stubFetch({ '/gists': (url, init) => json({ id: init.method === 'POST' ? 'g1' : url.split('/').pop() }) });

    const first = await capture(() => manifest.run({}, ['push']));
    assert.match(first.out, /Publishing the catalogue/);
    assert.match(first.out, /talea manifest pull g1/);
    assert.equal(readUserState().gist, 'g1');
    assert.equal(JSON.parse(calls[0].init.body).files['talea.repos.json'].content, readFileSync(USER_MANIFEST, 'utf8'));

    const second = await capture(() => manifest.run({}, ['push']));
    assert.match(second.out, /Updating the catalogue gist/);
    assert.equal(calls[1].init.method, 'PATCH');
    assert.match(calls[1].url, /\/gists\/g1$/);

    await capture(() => manifest.run({ gist: 'other' }, ['push']));
    assert.match(calls[2].url, /\/gists\/other$/);
  });

  test('pull with nothing to pull from says how to link one', async () => {
    process.env.GITHUB_TOKEN = 't';
    const r = await capture(() => manifest.run({}, ['pull']));
    assert.equal(r.exit, 1);
    assert.match(r.err, /No gist to pull from/);
  });

  test('pull writes the catalogue and remembers the gist', async () => {
    process.env.GITHUB_TOKEN = 't';
    let content = '{"repos":[{"name":"a"},{"name":"b"}]}';
    const calls = stubFetch({ '/gists/': () => json({ files: { 'talea.repos.json': { content } } }) });

    const r = await capture(() => manifest.run({}, ['pull', 'g9']));
    assert.equal(r.exit, null);
    assert.match(r.out, /2 repos/);
    assert.match(r.out, /Next: talea init/);
    assert.equal(readFileSync(USER_MANIFEST, 'utf8'), content + '\n');
    assert.equal(readUserState().gist, 'g9');

    content += '\n'; // already ends with a newline: written as is
    await capture(() => manifest.run({}, ['pull'])); // the remembered id
    assert.match(calls[1].url, /\/gists\/g9$/);
    assert.equal(readFileSync(USER_MANIFEST, 'utf8'), content);

    await capture(() => manifest.run({ gist: 'g7' }, ['pull']));
    assert.match(calls[2].url, /\/gists\/g7$/);
  });

  test('pull refuses what is not a catalogue, and leaves the good copy', async () => {
    process.env.GITHUB_TOKEN = 't';
    catalogue();
    const before = readFileSync(USER_MANIFEST, 'utf8');
    let content = 'not json';
    stubFetch({ '/gists/': () => json({ files: { f: { content } } }) });

    let r = await capture(() => manifest.run({}, ['pull', 'g']));
    assert.equal(r.exit, 1);
    assert.match(r.err, /That gist is not a catalogue/);

    for (content of ['{"groups":{}}', 'null']) {
      r = await capture(() => manifest.run({}, ['pull', 'g']));
      assert.equal(r.exit, 1);
      assert.match(r.err, /no `repos` array/);
    }

    // A catalogue in shape, but one entry would land outside the workspace.
    content = '{"repos":[{"name":"ok","owner":"me"},{"name":"app","owner":"me","dir":"../../outside/app"}]}';
    r = await capture(() => manifest.run({}, ['pull', 'g']));
    assert.equal(r.exit, 1);
    assert.match(r.err, /That gist is not a usable catalogue, so .* was left as it was/);
    assert.match(r.err, /repos\[1\] \(me\/app\): "dir" has a part that is "\.\."/);
    assert.equal(readFileSync(USER_MANIFEST, 'utf8'), before);

    // Past ten problems, the rest are counted rather than listed.
    content = JSON.stringify({ repos: Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, owner: '..' })) });
    r = await capture(() => manifest.run({}, ['pull', 'g']));
    assert.match(r.err, /… and 2 more/);
    assert.equal(readFileSync(USER_MANIFEST, 'utf8'), before);
  });

  test('pull warns when a nearer catalogue still wins', async () => {
    process.env.GITHUB_TOKEN = 't';
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-net-ws-')));
    writeFileSync(path.join(ws, '.talea.json'), '{}');
    writeFileSync(path.join(ws, 'talea.repos.json'), '{"repos":[]}');
    stubFetch({ '/gists/': () => json({ files: { f: { content: '{"repos":[]}' } } }) });
    process.chdir(ws);
    try {
      const r = await capture(() => manifest.run({}, ['pull', 'g']));
      assert.match(r.out, /A nearer catalogue is still winning/);

      const w = await capture(() => manifest.run({}, ['where']));
      assert.match(w.out, new RegExp(`workspace\\s+${ws.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
      assert.match(w.out, /gist\s+g\s+https:\/\/gist\.github\.com\/g/);
    } finally {
      process.chdir(HOME);
    }
  });

  test('where, with no workspace and no gist', async () => {
    const r = await capture(() => manifest.run({}));
    assert.match(r.out, /workspace\s+none found/);
    assert.match(r.out, /gist\s+not linked/);
    assert.match(r.out, /repos\s+0/);
  });

  test('an unknown verb exits non-zero', async () => {
    const r = await capture(() => manifest.run({}, ['psuh']));
    assert.equal(r.exit, 1);
    assert.match(r.err, /Unknown: talea manifest psuh/);
  });

  test('the state file lives under the temp home', () => {
    assert.ok(USER_STATE.startsWith(HOME));
  });
});
