// Self-update and `talea upgrade` — with no network and no real npm. The
// registry is a stubbed globalThis.fetch; `npm install -g`, the detached
// background run and the `.git` probe go through the `io` seam in src/update.js.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'talea-net-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.NO_COLOR = '1';
delete process.env.TALEA_NO_UPDATE_CHECK;
delete process.env.TALEA_BACKGROUND_UPGRADE;
process.chdir(HOME);

const update = await import('../src/update.js');
const upgrade = await import('../src/commands/upgrade.js');
const { readUserState, writeUserState, USER_STATE, updateUserState, renameInto } = await import('../src/config.js');
const { existsSync, readdirSync, readFileSync, writeFileSync: write, mkdirSync: mkdir, chmodSync } = await import('node:fs');

const { version, name } = update.pkgJson();
const realFetch = globalThis.fetch;
const realIo = { ...update.io };
const DAY = 24 * 60 * 60 * 1000;

async function capture(fn) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

/** The registry answers with `latest`, or with whatever `respond` returns. */
function registry(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof respond === 'function' ? respond() : new Response(JSON.stringify({ version: respond }));
  };
  return calls;
}

/** A child process that settles with `event` and `value` once listened to. */
function fakeChild(event, value) {
  const child = new EventEmitter();
  child.unref = () => {
    child.unrefed = true;
  };
  setImmediate(() => child.emit(event, value));
  return child;
}

function stubSpawn(event = 'close', value = 0) {
  const calls = [];
  update.io.spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild(event, value);
  };
  return calls;
}

const asNpmInstall = () => {
  update.io.existsSync = () => false;
};

const newer = (() => {
  const [a, b, c] = version.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
})();

beforeEach(() => {
  delete process.env.TALEA_NO_UPDATE_CHECK;
  delete process.env.TALEA_BACKGROUND_UPGRADE;
  update.io.existsSync = () => true; // a git checkout unless a test says otherwise
  stubSpawn('error', new Error('no real npm in tests'));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(update.io, realIo);
  process.exitCode = undefined;
  rmSync(path.join(HOME, '.talea'), { recursive: true, force: true });
});

// ── src/update.js ────────────────────────────────────────────────

test('installKind() reads a .git folder as a checkout', () => {
  Object.assign(update.io, realIo);
  // This file runs from a checkout of the repo, so the real probe says so.
  assert.equal(update.installKind(), 'local');
  update.io.existsSync = () => false;
  assert.equal(update.installKind(), 'npm');
});

test('isNewer() compares semver-ish strings', () => {
  assert.equal(update.isNewer('0.9.2', '0.10.0'), true);
  assert.equal(update.isNewer('v1.0.0', '1.0.1'), true);
  assert.equal(update.isNewer('1.2.3', '1.2.3'), false);
  assert.equal(update.isNewer('2.0.0', '1.9.9'), false);
  assert.equal(update.isNewer('1.0.0-beta', '1.0.0'), false);
  assert.equal(update.isNewer('1.2', '1.2.1'), true); // a missing part is 0
  assert.equal(update.isNewer('1.2.1', '1.2'), false);
  assert.equal(update.isNewer('1.2', '1.2.0'), false);
  assert.equal(update.isNewer('x.y.z', '0.0.1'), true); // junk parts are 0
});

describe('lookupLatestRelease()', () => {
  test('asks the registry for latest, by the package name by default', async () => {
    const calls = registry('1.2.3');
    assert.deepEqual(await update.lookupLatestRelease(), { version: '1.2.3' });
    assert.equal(calls[0].url, `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal(await update.latestRelease(), '1.2.3');
  });

  test('gives up on a registry that does not answer in time', async () => {
    // fetch rejects with the signal's TimeoutError; waiting out the real three
    // seconds would prove Node's timer, not this code.
    let signal;
    globalThis.fetch = (url, init) => {
      signal = init.signal;
      return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    };
    assert.deepEqual(await update.lookupLatestRelease('x'), {
      reason: 'timeout',
      detail: 'The operation was aborted due to timeout',
    });
    assert.equal(signal.aborted, false); // a timeout signal, not one already fired
  });

  test('names every way it can come back empty', async () => {
    registry(() => new Response('', { status: 404 }));
    assert.deepEqual(await update.lookupLatestRelease('x'), { reason: 'unpublished' });
    registry(() => new Response('', { status: 500 }));
    assert.deepEqual(await update.lookupLatestRelease('x'), { reason: 'unreachable' });
    registry(() => new Response('{}'));
    assert.deepEqual(await update.lookupLatestRelease('x'), { reason: 'untagged' });
    assert.equal(await update.latestRelease(), null);
    registry(() => {
      throw new Error('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    });
    assert.deepEqual(await update.lookupLatestRelease('x'), {
      reason: 'unreachable',
      detail: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    });
  });
});

describe('installLatest()', () => {
  test('runs npm install -g name@latest and resolves its exit code', async () => {
    const calls = stubSpawn('close', 0);
    assert.equal(await update.installLatest(), 0);
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['install', '-g', `${name}@latest`]);
    stubSpawn('close', 7);
    assert.equal(await update.installLatest('x'), 7);
    stubSpawn('close', null); // killed by a signal
    assert.equal(await update.installLatest('x'), 1);
    stubSpawn('error', new Error('ENOENT'));
    assert.equal(await update.installLatest('x'), 1);
  });

  test('needs a shell on Windows only, where npm is a .cmd', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      for (const [p, shell] of [
        ['win32', true],
        ['linux', false],
      ]) {
        Object.defineProperty(process, 'platform', { value: p });
        const calls = stubSpawn('close', 0);
        await update.installLatest('x');
        assert.equal(calls[0].opts.shell, shell);
      }
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('autoUpdateAsync()', () => {
  const run = () => capture(() => update.autoUpdateAsync());

  test('does nothing when turned off, by env or by state', async () => {
    const calls = registry('999.0.0');
    process.env.TALEA_NO_UPDATE_CHECK = '1';
    assert.deepEqual(await run(), { out: '', err: '' });
    delete process.env.TALEA_NO_UPDATE_CHECK;
    writeUserState({ updateCheck: false });
    assert.deepEqual(await run(), { out: '', err: '' });
    assert.equal(calls.length, 0);
  });

  test('a stale check that finds a newer release installs it in the background', async () => {
    asNpmInstall();
    registry(newer);
    const calls = stubSpawn();
    const r = await run();
    assert.match(r.err, new RegExp(`Updating in the background ${version} . ${newer}`));
    assert.equal(r.out, '');
    assert.equal(calls[0].cmd, process.execPath);
    assert.deepEqual(calls[0].args.slice(-1), ['upgrade']);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.env.TALEA_BACKGROUND_UPGRADE, '1');
    const s = readUserState();
    assert.equal(s.latestSeen, newer);
    assert.deepEqual({ from: s.autoUpdate.from, to: s.autoUpdate.to }, { from: version, to: newer });
  });

  test('an update already on its way is not started twice, and says nothing', async () => {
    asNpmInstall();
    registry(newer);
    const calls = stubSpawn();
    writeUserState({ autoUpdate: { from: version, to: newer, at: Date.now() } });
    const r = await run();
    assert.equal(calls.length, 0);
    assert.equal(r.err, '');
  });

  test('a pending record a day old no longer blocks', async () => {
    asNpmInstall();
    registry(newer);
    const calls = stubSpawn();
    writeUserState({ autoUpdate: { from: version, to: newer, at: Date.now() - 2 * DAY } });
    await run();
    assert.equal(calls.length, 1);
  });

  test('a git checkout is only told', async () => {
    registry(newer);
    const calls = stubSpawn();
    const r = await run();
    assert.equal(calls.length, 0);
    assert.match(r.err, new RegExp(`Update available ${version} . ${newer}\\s+run talea upgrade`));
  });

  test('an unreachable registry keeps the last seen version and says nothing', async () => {
    registry(() => new Response('', { status: 500 }));
    writeUserState({ lastCheck: 0, latestSeen: version });
    const r = await run();
    assert.equal(r.err, '');
    const s = readUserState();
    assert.equal(s.latestSeen, version);
    assert.ok(s.lastCheck > 0);
  });

  test('a fresh check is not repeated; the cached notice still shows', async () => {
    const calls = registry(newer);
    writeUserState({ lastCheck: Date.now(), latestSeen: newer });
    assert.match((await run()).err, /Update available/);
    writeUserState({ lastCheck: Date.now(), latestSeen: version });
    assert.equal((await run()).err, '');
    writeUserState({ lastCheck: Date.now() });
    assert.equal((await run()).err, '');
    assert.equal(calls.length, 0);
  });

  test('reports the last background run once, then forgets it', async () => {
    registry(version);
    writeUserState({ lastCheck: Date.now(), autoUpdate: { from: '0.0.1', to: version, at: Date.now() } });
    assert.match((await run()).err, new RegExp(`Updated 0\\.0\\.1 . ${version}`));
    assert.equal(readUserState().autoUpdate, undefined);

    writeUserState({ lastCheck: Date.now(), autoUpdate: { from: version, to: newer, at: Date.now(), failed: 243 } });
    assert.match((await run()).err, /Automatic update failed \(npm exited 243\).*update\.log/s);
    assert.equal(readUserState().autoUpdate, undefined);
  });
});

// ── src/commands/upgrade.js ──────────────────────────────────────

describe('talea upgrade', () => {
  test('--on and --off flip the automatic update', async () => {
    writeUserState({ gist: 'kept' });
    assert.match((await capture(() => upgrade.run({ off: true }))).out, /automatic updates off/);
    assert.deepEqual(readUserState(), { gist: 'kept', updateCheck: false });
    assert.match((await capture(() => upgrade.run({ on: true }))).out, /automatic updates on/);
    assert.equal(readUserState().updateCheck, true);
  });

  test('says why there is nothing to compare against', async () => {
    const cases = [
      [() => new Response('', { status: 404 }), /is not on the registry yet/],
      [() => new Response('', { status: 500 }), /could not reach the registry/],
      [() => new Response('{}'), /the registry has no version for it/],
      [
        () => {
          throw new DOMException('x', 'TimeoutError');
        },
        /did not answer in time/,
      ],
    ];
    for (const [respond, why] of cases) {
      registry(respond);
      const r = await capture(() => upgrade.run({}));
      assert.match(r.out, why);
      assert.match(r.out, new RegExp(`Installed: ${version}`));
    }
    assert.equal(readUserState().lastCheck, undefined);
  });

  test('already on the latest caches the check', async () => {
    registry(version);
    const r = await capture(() => upgrade.run({}));
    assert.match(r.out, /already on the latest version/);
    assert.equal(readUserState().latestSeen, version);
  });

  test('--check reports and installs nothing', async () => {
    registry(newer);
    const calls = stubSpawn();
    const r = await capture(() => upgrade.run({ check: true }));
    assert.match(r.out, new RegExp(`${version} . ${newer}`));
    assert.match(r.out, /Run `talea upgrade` to install it/);
    assert.equal(calls.length, 0);
  });

  test('a git checkout is refused', async () => {
    registry(newer);
    const calls = stubSpawn();
    const r = await capture(() => upgrade.run({}));
    assert.match(r.out, /this copy is a git checkout/);
    assert.equal(calls.length, 0);
  });

  test('installs from npm', async () => {
    asNpmInstall();
    registry(newer);
    const calls = stubSpawn('close', 0);
    const r = await capture(() => upgrade.run({}));
    assert.deepEqual(calls[0].args, ['install', '-g', `${name}@latest`]);
    assert.match(r.out, new RegExp(`upgraded to ${newer}`));
    assert.equal(process.exitCode, undefined);
  });

  test('a failed install exits with npm’s code', async () => {
    asNpmInstall();
    registry(newer);
    stubSpawn('close', 5);
    const r = await capture(() => upgrade.run({}));
    assert.match(r.err, /npm install exited 5/);
    assert.equal(process.exitCode, 5);
  });

  test('a failed background install records its exit code for the next run', async () => {
    asNpmInstall();
    process.env.TALEA_BACKGROUND_UPGRADE = '1';
    registry(newer);
    stubSpawn('close', 243);

    // No record: nothing to annotate.
    await capture(() => upgrade.run({}));
    assert.equal(readUserState().autoUpdate, undefined);

    writeUserState({ autoUpdate: { from: version, to: newer, at: 1 } });
    await capture(() => upgrade.run({}));
    assert.deepEqual(readUserState().autoUpdate, { from: version, to: newer, at: 1, failed: 243 });
    assert.equal(process.exitCode, 243);
  });
});

// ── two talea processes at once ─────────────────────────────────
// The background upgrade and the command the developer typed share
// ~/.talea/state.json and one global npm prefix. Issue #23.

describe('runs that overlap', () => {

  test('state is written whole or not at all: no half file, no temp left behind', () => {
    writeUserState({ workspaces: ['/a'], gist: 'g' });
    assert.deepEqual(readUserState(), { workspaces: ['/a'], gist: 'g' });
    assert.deepEqual(readdirSync(path.dirname(USER_STATE)).filter((f) => f.endsWith('.tmp')), []);
  });

  test('a write that cannot land removes its temp file and never throws', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    writeUserState({ gist: 'kept' });
    chmodSync(path.dirname(USER_STATE), 0o500);
    try {
      writeUserState({ gist: 'lost' });
    } finally {
      chmodSync(path.dirname(USER_STATE), 0o700);
    }
    assert.equal(readUserState().gist, 'kept');
    assert.deepEqual(readdirSync(path.dirname(USER_STATE)).filter((f) => f.endsWith('.tmp')), []);
  });

  test('upgrade keeps what another run saved while it waited on the registry', async () => {
    writeUserState({ workspaces: ['/a'] });
    registry(() => {
      // Mid-request: `talea init` elsewhere records a workspace.
      updateUserState((s) => ({ ...s, workspaces: [...s.workspaces, '/b'] }));
      return new Response(JSON.stringify({ version }));
    });
    await capture(() => upgrade.run({}));
    assert.deepEqual(readUserState().workspaces, ['/a', '/b']);
    assert.ok(readUserState().lastCheck);
  });

  test('the daily check decides on the state after the registry answers, so two runs start one update', async () => {
    asNpmInstall();
    writeUserState({ lastCheck: 0 });
    const calls = stubSpawn('close', 0);
    registry(() => {
      // Mid-request: the other run already started this update.
      updateUserState((s) => ({ ...s, autoUpdate: { from: version, to: newer, at: Date.now() }, workspaces: ['/kept'] }));
      return new Response(JSON.stringify({ version: newer }));
    });
    await capture(() => update.autoUpdateAsync());
    assert.equal(calls.length, 0, 'a second background install was started');
    assert.deepEqual(readUserState().workspaces, ['/kept']);
  });

  test('one install at a time: a held lock stops a second upgrade before npm runs', async () => {
    asNpmInstall();
    registry(newer);
    const calls = stubSpawn('close', 0);
    const release = update.takeUpgradeLock();
    assert.equal(typeof release, 'function');
    assert.equal(update.takeUpgradeLock(), null, 'two holders at once');
    const r = await capture(() => upgrade.run({}));
    assert.match(r.out, /another talea upgrade is installing right now/);
    assert.equal(calls.length, 0);
    release();
    // Free again: the install runs and lets go of the lock afterwards.
    await capture(() => upgrade.run({}));
    assert.equal(calls.length, 1);
    assert.equal(existsSync(update.UPGRADE_LOCK), false);
  });

  test('a lock whose process is gone, or that is too old, is taken over; a live one is not', async () => {
    mkdir(path.dirname(update.UPGRADE_LOCK), { recursive: true });
    const now = Date.now();
    const lockedBy = (content) => write(update.UPGRADE_LOCK, content);
    const alive = (pid) => pid === 4242;
    lockedBy(`4242 ${now}`);
    assert.equal(update.takeUpgradeLock(now, { alive }), null, 'a live install was taken over');
    // Ctrl-C mid-install: the process is gone, the file is not.
    lockedBy(`999999 ${now}`);
    let release = update.takeUpgradeLock(now, { alive });
    assert.equal(typeof release, 'function');
    assert.equal(readFileSync(update.UPGRADE_LOCK, 'utf8'), `${process.pid} ${now}`);
    release();
    assert.equal(existsSync(update.UPGRADE_LOCK), false);
    // Alive but older than any install: a reused pid.
    lockedBy(`4242 ${now - DAY}`);
    assert.equal(typeof update.takeUpgradeLock(now, { alive })(), 'undefined');
    // Not a lock talea wrote.
    lockedBy('garbage');
    assert.equal(typeof update.takeUpgradeLock(now, { alive })(), 'undefined');
    // The real liveness check: this process is alive, an exited one is not.
    lockedBy(`${process.pid} ${now}`);
    assert.equal(update.takeUpgradeLock(now), null);
    const { spawnSync } = await import('node:child_process');
    lockedBy(`${spawnSync(process.execPath, ['-e', '']).pid} ${now}`);
    assert.equal(typeof update.takeUpgradeLock(now), 'function');
  });

  test('release frees only this run\'s lock, not one another run took over meanwhile', () => {
    const release = update.takeUpgradeLock();
    write(update.UPGRADE_LOCK, `4242 ${Date.now()}`); // taken over by another run
    release();
    assert.equal(readFileSync(update.UPGRADE_LOCK, 'utf8').startsWith('4242 '), true);
    rmSync(update.UPGRADE_LOCK);
    release(); // already gone: no throw
  });

  test('a lock released between two looks, or claimed by another run first, is asked about again', async () => {
    const fs = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const stub = (name, make) => {
      const real = fs.default[name];
      fs.default[name] = make(real);
      syncBuiltinESMExports();
      return () => {
        fs.default[name] = real;
        syncBuiltinESMExports();
      };
    };
    mkdir(path.dirname(update.UPGRADE_LOCK), { recursive: true });
    // Present when created, gone when read: the next try takes it.
    write(update.UPGRADE_LOCK, `4242 ${Date.now()}`);
    let first = true;
    let restore = stub('readFileSync', (real) => (f, ...rest) => {
      if (f === update.UPGRADE_LOCK && first) {
        first = false;
        rmSync(update.UPGRADE_LOCK);
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }
      return real(f, ...rest);
    });
    try {
      assert.equal(typeof update.takeUpgradeLock(), 'function');
    } finally {
      restore();
    }
    // Abandoned, but every claim loses to another run: it gives up rather than spin.
    write(update.UPGRADE_LOCK, `999999 ${Date.now()}`);
    restore = stub('renameSync', () => () => {
      throw Object.assign(new Error('claimed'), { code: 'ENOENT' });
    });
    try {
      assert.equal(update.takeUpgradeLock(Date.now(), { alive: () => false }), null);
    } finally {
      restore();
    }
  });

  test('a typed upgrade the lock stops exits non-zero; the background one stays quiet', async () => {
    asNpmInstall();
    registry(newer);
    stubSpawn('close', 0);
    mkdir(path.dirname(update.UPGRADE_LOCK), { recursive: true });
    write(update.UPGRADE_LOCK, `${process.pid} ${Date.now()}`);
    await capture(() => upgrade.run({}));
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    process.env.TALEA_BACKGROUND_UPGRADE = '1';
    await capture(() => upgrade.run({}));
    assert.equal(process.exitCode, undefined);
  });

  test('a state write whose home is not a directory is dropped, never thrown', () => {
    rmSync(path.join(HOME, '.talea'), { recursive: true, force: true });
    write(path.join(HOME, '.talea'), 'a file, not a folder');
    try {
      writeUserState({ gist: 'x' });
    } finally {
      rmSync(path.join(HOME, '.talea'), { force: true });
    }
  });

  test('on Windows a rename that something holds open is retried briefly, elsewhere it is not', () => {
    const busy = (times) => {
      let n = 0;
      return () => {
        if (n++ < times) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        return 'renamed';
      };
    };
    assert.equal(renameInto('a', 'b', { rename: busy(3), platform: 'win32' }), 'renamed');
    assert.throws(() => renameInto('a', 'b', { rename: busy(3), platform: 'linux' }), /busy/);
    assert.throws(() => renameInto('a', 'b', { rename: busy(20), platform: 'win32' }), /busy/);
    assert.throws(
      () => renameInto('a', 'b', { rename: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, platform: 'win32' }),
      /nope/,
    );
  });

  test('a home where no lock can be made still upgrades, without the guard', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    mkdir(path.dirname(update.UPGRADE_LOCK), { recursive: true });
    chmodSync(path.dirname(update.UPGRADE_LOCK), 0o500);
    try {
      const release = update.takeUpgradeLock();
      assert.equal(typeof release, 'function');
      release(); // a no-op, and no throw
    } finally {
      chmodSync(path.dirname(update.UPGRADE_LOCK), 0o700);
    }
  });
});
