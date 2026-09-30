// Update checking and self-upgrade.
//
// Automatic, but never silent and never mid-run. This tool moves checkouts
// around; changing its behaviour without the developer knowing is how you get
// an unreproducible bug report. So a newer release is installed in the
// background once a day, the run that started it finishes on the old version,
// and the next run says which version it is now. `talea upgrade --off` stops it.

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { USER_DIR, readUserState, writeUserState } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.join(here, '..');

/** Subprocess and filesystem probes, swappable so a test never runs a real npm. */
export const io = { spawn, existsSync };

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;

export const pkgJson = () =>
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/**
 * How this copy was installed, which decides whether upgrading is ours to do.
 *   'local' — a git checkout (npm link, or run straight from source)
 *   'npm'   — installed from the registry
 */
export function installKind() {
  return io.existsSync(path.join(PACKAGE_ROOT, '.git')) ? 'local' : 'npm';
}

/** Compare semver-ish strings. Returns true when `b` is newer than `a`. */
export function isNewer(a, b) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((y[i] ?? 0) > (x[i] ?? 0)) return true;
    if ((y[i] ?? 0) < (x[i] ?? 0)) return false;
  }
  return false;
}

/**
 * The version the registry currently calls `latest`.
 *
 * The registry endpoint rather than `npm view`, because spawning npm to read
 * one string costs half a second and pulls a whole config resolution in with
 * it. Resolves `{ version }` or `{ reason }` — never throws, and never blocks
 * for longer than the timeout.
 */
export async function lookupLatestRelease(name = pkgJson().name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      // Rejects with a TimeoutError. No timer of our own to clear, and none
      // that keeps the process alive after the command has finished.
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'talea' },
    });
    if (!res.ok) return { reason: res.status === 404 ? 'unpublished' : 'unreachable' };
    const { version } = await res.json();
    return version ? { version } : { reason: 'untagged' };
  } catch (err) {
    return { reason: err.name === 'TimeoutError' ? 'timeout' : 'unreachable', detail: err.message };
  }
}

export const latestRelease = async () => (await lookupLatestRelease()).version ?? null;

/** Reinstall globally from the registry. Resolves the exit code. */
export function installLatest(name = pkgJson().name) {
  return new Promise((resolve) => {
    const child = io.spawn('npm', ['install', '-g', `${name}@latest`], {
      stdio: 'inherit',
      // npm is a .cmd on Windows, which spawn cannot exec without a shell.
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const checksDisabled = () =>
  process.env.TALEA_NO_UPDATE_CHECK === '1' || readUserState().updateCheck === false;

export const UPDATE_LOG = path.join(USER_DIR, 'update.log');

/**
 * What became of the last background update, read on the run after it.
 *   'updated' — this copy is newer than the one that started it
 *   'failed'  — the background `talea upgrade` recorded a non-zero npm exit
 *   null      — still running, or nothing was started
 */
export function autoUpdateOutcome(record, version) {
  if (!record) return null;
  if (isNewer(record.from, version)) return 'updated';
  if (record.failed != null) return 'failed';
  return null;
}

/**
 * Start `talea upgrade` detached, with its output in ~/.talea/update.log.
 *
 * The upgrade command rather than a bare `npm install`, because it already
 * refuses a git checkout and it can record its own exit code — a detached npm
 * would fail with nobody left to hear it.
 */
function spawnBackgroundUpgrade() {
  mkdirSync(USER_DIR, { recursive: true });
  const out = openSync(UPDATE_LOG, 'w');
  const child = io.spawn(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'talea.js'), 'upgrade'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, TALEA_BACKGROUND_UPGRADE: '1' },
  });
  child.unref();
  closeSync(out);
}

/**
 * After every command: report the last background update, refresh the cached
 * latest version at most once a day, and when that refresh finds a newer one,
 * install it in the background.
 *
 * The running command never changes version underneath itself — the new copy
 * is what the *next* run loads, and that run says so, once. Everything here
 * goes to stderr: `cd $(talea where)` reads stdout, and a notice there is a
 * directory that does not exist.
 *
 * Never throws — an update check must not be able to fail a clone.
 */
export async function autoUpdateAsync() {
  if (checksDisabled()) return;

  const { version } = pkgJson();
  let state = readUserState();
  const { c, glyph } = await import('./log.js');
  const say = (s) => console.error(c.dim(`\n${glyph.rule.repeat(6)}\n`) + s + '\n');

  const outcome = autoUpdateOutcome(state.autoUpdate, version);
  if (outcome === 'updated') {
    say(`${c.green('Updated')} ${c.dim(state.autoUpdate.from)} ${glyph.arrow} ${c.green(version)}`);
  } else if (outcome === 'failed') {
    say(
      `${c.yellow('Automatic update failed')} ${c.dim(`(npm exited ${state.autoUpdate.failed})`)}  ` +
        `see ${c.dim(UPDATE_LOG)} or run ${c.bold('talea upgrade')}`,
    );
  }
  if (outcome) {
    const { autoUpdate, ...rest } = state;
    writeUserState((state = rest));
  }

  // Once a day. Only a fresh check starts an install, so a failing one is
  // retried daily, not on every command.
  if (Date.now() - (state.lastCheck ?? 0) > CHECK_INTERVAL_MS) {
    const latest = await latestRelease();
    state = { ...state, lastCheck: Date.now(), ...(latest ? { latestSeen: latest } : {}) };
    // A record a day old with no outcome is a background run that died before
    // it could write one; it must not block every update after it.
    const pending = state.autoUpdate && Date.now() - state.autoUpdate.at < CHECK_INTERVAL_MS;
    const due = latest && isNewer(version, latest) && installKind() === 'npm' && !pending;
    if (due) state.autoUpdate = { from: version, to: latest, at: Date.now() };
    writeUserState(state);
    if (due) {
      spawnBackgroundUpgrade();
      say(`${c.dim('Updating in the background')} ${c.dim(version)} ${glyph.arrow} ${c.green(latest)}`);
      return;
    }
  }

  // A git checkout, or an update already on its way: the notice is all there is.
  if (!state.autoUpdate && state.latestSeen && isNewer(version, state.latestSeen)) {
    say(
      `${c.yellow('Update available')} ${c.dim(version)} ${glyph.arrow} ${c.green(state.latestSeen)}  ` +
        `run ${c.bold('talea upgrade')}`,
    );
  }
}
