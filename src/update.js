// Update checking and self-upgrade.
//
// Deliberately NOT a silent auto-updater. This tool moves checkouts around;
// changing its own behaviour mid-session without the developer knowing is how
// you get an unreproducible bug report. So: a passive, cached, once-a-day
// notice plus an explicit `talea upgrade`.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readUserState, writeUserState } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.join(here, '..');

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
  return existsSync(path.join(PACKAGE_ROOT, '.git')) ? 'local' : 'npm';
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'talea' },
    });
    if (!res.ok) return { reason: res.status === 404 ? 'unpublished' : 'unreachable' };
    const { version } = await res.json();
    return version ? { version } : { reason: 'untagged' };
  } catch (err) {
    return { reason: err.name === 'AbortError' ? 'timeout' : 'unreachable', detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export const latestRelease = async () => (await lookupLatestRelease()).version ?? null;

/** Reinstall globally from the registry. Resolves the exit code. */
export function installLatest(name = pkgJson().name) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${name}@latest`], {
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

/**
 * Print a one-line notice if a newer version was seen. Uses the *cached* result
 * so it costs nothing, then refreshes the cache at most once a day.
 *
 * Runs after the real work and never throws — an update check must not be able
 * to fail a clone.
 */
export async function notifyIfOutdatedAsync() {
  if (checksDisabled()) return;

  const { version } = pkgJson();
  const state = readUserState();

  if (state.latestSeen && isNewer(version, state.latestSeen)) {
    const { c, glyph } = await import('./log.js');
    console.log(
      c.dim(`\n${glyph.rule.repeat(6)}\n`) +
        `${c.yellow('Update available')} ${c.dim(version)} ${glyph.arrow} ${c.green(state.latestSeen)}  ` +
        `run ${c.bold('talea upgrade')}\n`,
    );
  }

  if (Date.now() - (state.lastCheck ?? 0) <= CHECK_INTERVAL_MS) return;

  const latest = await latestRelease();
  writeUserState({ ...state, lastCheck: Date.now(), ...(latest ? { latestSeen: latest } : {}) });
}
