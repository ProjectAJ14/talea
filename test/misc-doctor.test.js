// `talea doctor`, with the SSH probe and the GitHub calls replaced — a test
// never dials github.com. The probe itself is run against `node` standing in
// for ssh, which prints what GitHub would.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test, { after, afterEach, beforeEach, describe } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js reads the home directory on load.
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-home-')));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
const { run, probe, sshProbe, sshVerdict } = await import('../src/commands/doctor.js');
const github = await import('../src/github.js');

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-doctor-')));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const node = (code) => [process.execPath, '-e', code];

describe('the SSH probe', () => {
  test('reads the text, not the exit code', async () => {
    // GitHub authenticates, then refuses the shell with a non-zero exit.
    const res = await sshProbe(
      node(`console.log("Hi me! You've successfully authenticated"); console.error("bye"); process.exit(1)`),
      3000,
    );
    assert.deepEqual(res, { ok: true, message: "Hi me! You've successfully authenticated" });
  });

  test('a missing ssh is a failure with the reason', async () => {
    const res = await sshProbe([path.join(tmp, 'no-such-ssh')], 50);
    assert.equal(res.ok, false);
    assert.ok(res.message);
  });

  test('a probe that hangs is killed at the timeout', async () => {
    const res = await sshProbe(node('setTimeout(() => {}, 60000)'), 50);
    assert.equal(res.ok, false);
  });

  test('a denial wins over a welcome', () => {
    assert.equal(sshVerdict('Welcome\nPermission denied (publickey).').ok, false);
    assert.equal(sshVerdict('Connection refused').ok, false);
  });

  // `text.split('\n')[0]` is always a string, so the old `?? 'no response'`
  // never fired: a probe killed with no output reports an empty message.
  test('a probe with no output says "no response" rather than nothing', () => {
    assert.equal(sshVerdict('').message, 'no response');
  });

  // The kill timer used to outlive ssh, so `talea doctor` stayed alive for the
  // whole timeout after ssh had already answered.
  test('the probe does not hold the process open once ssh has answered', () => {
    const url = new URL('../src/commands/doctor.js', import.meta.url).href;
    const script = `const { sshProbe } = await import(${JSON.stringify(url)});
      await sshProbe([process.execPath, '-e', ''], 60000);`;
    const started = Date.now();
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
    });
    assert.ok(Date.now() - started < 30000, 'the process waited for the kill timer');
  });
});

describe('talea doctor', () => {
  let out;
  const saved = {};
  beforeEach(() => {
    out = [];
    Object.assign(saved, {
      log: console.log,
      error: console.error,
      cwd: process.cwd(),
      ssh: probe.ssh,
      io: { ...github.io },
      env: { ...process.env },
      versions: Object.getOwnPropertyDescriptor(process, 'versions'),
    });
    console.log = console.error = (s = '') => out.push(String(s));
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // No system or global git config leaks in: user.email is what we say.
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'no-gitconfig');
  });
  afterEach(() => {
    console.log = saved.log;
    console.error = saved.error;
    process.chdir(saved.cwd);
    probe.ssh = saved.ssh;
    Object.assign(github.io, saved.io);
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    Object.defineProperty(process, 'versions', saved.versions);
    process.exitCode = undefined;
  });

  /** `gh` answers: `token` for `gh auth token`, `user` as the /user JSON (or a failure). */
  const fakeGh = ({ token = null, user } = {}) => {
    github.io.gh = true;
    github.io.spawnSync = (cmd, args) => {
      if (args[0] === 'auth') return token ? { status: 0, stdout: `${token}\n` } : { status: 1, stdout: '' };
      if (user === undefined) return { status: 1, stderr: 'HTTP 401: Bad credentials' };
      return { status: 0, stdout: JSON.stringify(user) };
    };
  };

  test('everything in order: all clear, inside a workspace that has chosen', async () => {
    const ws = path.join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'talea.repos.json'), JSON.stringify({ repos: [{ name: 'app', owner: 'me' }] }));
    writeFileSync(path.join(ws, '.talea.json'), JSON.stringify({ selected: ['app'] }));
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\temail = me@example.com\n');
    process.chdir(ws);
    probe.ssh = async () => ({ ok: true, message: 'Hi me!' });
    fakeGh({ token: 'tok', user: { login: 'me' } });

    await run();
    const text = out.join('\n');
    assert.match(text, /me@example\.com/);
    assert.match(text, /gh auth token/);
    assert.match(text, /1 repos/);
    assert.match(text, /ALL CLEAR/);
    assert.doesNotMatch(text, /settings\/keys/);
    rmSync(process.env.GIT_CONFIG_GLOBAL);
  });

  test('everything wrong: old Node, no git, no SSH, no token, no workspace', async () => {
    const empty = path.join(tmp, 'nowhere');
    mkdirSync(empty, { recursive: true });
    process.chdir(empty);
    Object.defineProperty(process, 'versions', {
      value: { ...process.versions, node: '18.0.0' },
      configurable: true,
    });
    process.env.PATH = path.join(tmp, 'empty-bin');
    probe.ssh = async () => ({ ok: false, message: 'Permission denied (publickey).' });
    fakeGh();

    await run();
    const text = out.join('\n');
    assert.match(text, /need >= 20/);
    assert.match(text, /not found on PATH/);
    assert.match(text, /not set/);
    assert.match(text, /public repos only/);
    assert.match(text, /none found/);
    assert.match(text, /empty — run `talea discover`/);
    assert.match(text, /problem\(s\) to fix/);
    assert.match(text, /settings\/keys/);
  });

  test('a token that GitHub rejects, and one with no login, in a workspace not yet chosen', async () => {
    const ws = path.join(tmp, 'ws2');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'talea.repos.json'), JSON.stringify({ repos: [{ name: 'app', owner: 'me', default: true }] }));
    writeFileSync(path.join(ws, '.talea.json'), '{}');
    process.chdir(ws);
    probe.ssh = async () => ({ ok: true, message: 'Hi' });

    process.env.GITHUB_TOKEN = 'bad';
    fakeGh();
    await run();
    assert.match(out.join('\n'), /Bad credentials/);
    assert.match(out.join('\n'), /by default — not chosen yet/);

    out = [];
    fakeGh({ user: {} });
    await run();
    assert.match(out.join('\n'), /GITHUB_TOKEN/);
  });
});
