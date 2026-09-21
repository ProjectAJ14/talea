// Git plumbing. Everything shells out to the `git` binary with shell:false so
// that repo names, branch names and Windows paths containing spaces are passed
// through verbatim — no quoting rules to get wrong on cmd.exe vs bash.

import { spawn } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';

// Environment variables that point git at a specific repository, overriding
// `cwd` completely. Git exports several of them into hooks, so a `talea`
// command run from inside one — or from any wrapper that exports them — would
// otherwise run every operation against the wrong repository. `adopt` decides
// what to move from `git remote get-url origin`, so a leaked GIT_DIR makes 47
// separate checkouts all report one remote and look like copies of each other.
//
// Cleared rather than trusted: `cwd` is the only thing that should select the
// repository here.
const REPO_SCOPING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
];

/** process.env with anything that would redirect git away from `cwd` removed. */
export function cleanGitEnv(base = process.env) {
  const env = { ...base };
  // Node omits a variable whose value is undefined when spawning.
  for (const name of REPO_SCOPING_VARS) env[name] = undefined;
  return env;
}

/**
 * Run git and capture output. Never throws on a non-zero exit; callers decide
 * what a failure means, which keeps "branch missing" from looking like a crash.
 */
export function git(args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env: {
        ...cleanGitEnv(),
        // Never let git stop mid-run waiting for credentials — a hung prompt
        // across 47 repos is far worse than a clean per-repo failure.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        ...env,
      },
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    if (input != null) {
      // A git that exits before reading all of stdin (or is missing) gives an
      // EPIPE here; the exit code and stderr are the real signal, so swallow it.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) =>
      resolve({ code: -1, stdout: '', stderr: err.message }),
    );
    child.on('close', (code) =>
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
  });
}

// Git writes `<ref>.lock` while it updates a ref and removes it when it is done.
// A fetch that dies mid-write — Ctrl-C, a closed laptop, a killed pool worker —
// leaves the lock behind, and every fetch afterwards fails with
// "cannot lock ref … File exists" until a human deletes the file. Across 47
// repos that is a permanent, self-inflicted failure, so clear the locks git
// itself named in the error and run the command again.
//
// Age is the only safe test for "nobody owns this": a lock a live git holds is
// at most seconds old, whether it is ours or another terminal's. Anything older
// than a minute is debris. This never touches anything but a `.lock` file —
// git forbids a ref name ending in `.lock`, so there is no repo content behind
// that suffix.
const STALE_LOCK_MS = 60_000;

/** Absolute paths of the `*.lock` files quoted in a git error message. */
function lockPathsIn(stderr, cwd) {
  const quoted = String(stderr).matchAll(/'([^']*\.lock)'/g);
  return [...new Set([...quoted].map((m) => path.resolve(cwd ?? process.cwd(), m[1])))];
}

/** Remove the locks git named that are too old to belong to a running git. */
function clearStaleLocks(stderr, cwd) {
  let cleared = 0;
  for (const lock of lockPathsIn(stderr, cwd)) {
    try {
      if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) continue;
      unlinkSync(lock);
      cleared++;
    } catch {
      // Already gone, or not ours to remove. The retry decides either way.
    }
  }
  return cleared;
}

// The other way "cannot lock ref … File exists" happens, and no lock file on
// disk explains it: macOS and Windows filesystems are case-insensitive, so two
// branches on origin whose names differ only in case —
// `INT-1203-on-UAT` and `INT-1203-on-Uat`, `optimize-CICD` and `optimize-cicd`
// — are one path locally. `fetch --prune` locks the first, collides on the
// second, and fails. Nothing is stale and waiting does not help: the pair can
// never both exist as files, so every fetch fails until one of them is gone.
//
// Dropping the ref git named is the recovery, and this is the only place it is
// safe: a `refs/remotes/` ref is a cache of origin that the same fetch rebuilds.
// Nothing under `refs/heads/` or `refs/stash` is ever touched here.
const CANNOT_LOCK = /cannot lock ref '(refs\/remotes\/[^']+)'/g;

async function dropCollidingRefs(stderr, opts) {
  // A lock file that is still on disk means a live git owns it — the age check
  // above already declined to remove it, so do not go behind its back either.
  if (lockPathsIn(stderr, opts?.cwd).some(existsSync)) return 0;

  const named = new Set([...String(stderr).matchAll(CANNOT_LOCK)].map((m) => m[1]));
  let dropped = 0;
  for (const ref of named) {
    const { code: exists } = await git(['show-ref', '--verify', '--quiet', ref], opts);
    if (exists !== 0) continue; // already gone; not progress, so do not loop on it
    const { code } = await git(['update-ref', '-d', ref], opts);
    if (code === 0) dropped++;
  }
  return dropped;
}

/**
 * Run git, healing the two ref-lock failures that a retry alone cannot fix:
 * debris from a killed git, and a case-collision between two remote branches.
 * Retries only while it is actually clearing something, so a genuine failure
 * returns after the first run and a lock a live git holds is reported rather
 * than stolen.
 */
async function unlocking(args, opts) {
  let res = await git(args, opts);
  // Git reports one collision per run, and a repo with years of branches can
  // have several, so the cap is per-repo patience rather than per-failure.
  for (let i = 0; i < 10 && res.code !== 0; i++) {
    const healed =
      clearStaleLocks(res.stderr, opts?.cwd) || (await dropCollidingRefs(res.stderr, opts));
    if (!healed) break;
    res = await git(args, opts);
  }
  return res;
}

/**
 * Origin is gone, renamed, or this account was never granted it. Neither a
 * retry nor anything the developer can do at their keyboard fixes it, so bulk
 * commands report it and move on instead of failing the whole run.
 */
export const isMissingRemote = (stderr) =>
  /TF401019|repository not found|does not exist or you do not have permission/i.test(
    String(stderr),
  );

export const isRepo = (dir) => existsSync(path.join(dir, '.git'));

export async function gitVersion() {
  const { code, stdout } = await git(['--version']);
  return code === 0 ? stdout.replace('git version ', '') : null;
}

export async function currentBranch(dir) {
  const { code, stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dir,
  });
  return code === 0 ? stdout : null;
}

/** True when the working tree has uncommitted changes (tracked or untracked). */
export async function isDirty(dir) {
  const { code, stdout } = await git(['status', '--porcelain'], { cwd: dir });
  return code === 0 && stdout.length > 0;
}

/** Commits ahead of / behind the upstream, or null when there is no upstream. */
export async function aheadBehind(dir) {
  const { code, stdout } = await git(
    ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
    { cwd: dir },
  );
  if (code !== 0) return null;
  const [behind, ahead] = stdout.split(/\s+/).map(Number);
  return { ahead, behind };
}

/** Does `branch` exist on the remote? Uses the local remote-tracking refs. */
export async function remoteHasBranch(dir, branch) {
  const { code } = await git(
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    { cwd: dir },
  );
  return code === 0;
}

export async function localHasBranch(dir, branch) {
  const { code } = await git(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: dir },
  );
  return code === 0;
}

export const fetch = (dir) => unlocking(['fetch', '--prune', 'origin'], { cwd: dir });

/**
 * Check out `branch`, creating it from origin/<branch> on first use.
 * Assumes the caller has already fetched and confirmed the branch exists.
 */
export async function checkout(dir, branch) {
  if (await localHasBranch(dir, branch)) {
    return unlocking(['checkout', branch], { cwd: dir });
  }
  return unlocking(['checkout', '-b', branch, '--track', `origin/${branch}`], {
    cwd: dir,
  });
}

/**
 * Fast-forward the current branch onto its already-fetched upstream.
 *
 * Fast-forward only: a merge commit invented across 47 repos is the kind of
 * history nobody can unpick afterwards, so a diverged branch fails loudly.
 *
 * This is deliberately `merge`, not `pull`. Every caller fetches first, and
 * `git pull` fetches *again* — one extra network round-trip per repo, which
 * over 47 repos on a VPN was most of the wall-clock time `talea sync` spent.
 * Merging the ref that fetch just updated does the same work with one.
 */
export const ffMerge = (dir) =>
  unlocking(['merge', '--ff-only', '@{upstream}'], { cwd: dir });

/** Does the current branch track anything? `ffMerge` has nothing to do if not. */
export async function hasUpstream(dir) {
  const { code } = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: dir,
  });
  return code === 0;
}

export const stashPush = (dir, message) =>
  git(['stash', 'push', '--include-untracked', '-m', message], { cwd: dir });

export const clone = (url, dest, branch) =>
  git(['clone', ...(branch ? ['--branch', branch] : []), '--', url, dest]);

/**
 * How many git operations run at once when `-j` is not given.
 *
 * This work is network-bound, not CPU-bound, so the core count is a proxy for
 * "how big is this machine" rather than a real limit — but it beats the flat 6
 * this used to be, which left a modern laptop idle for most of a clone. Capped
 * at 12 because the far end is one SSH server and 47 simultaneous sessions is
 * how you get throttled; floored at 6 so it never runs slower than it used to.
 */
export const defaultJobs = () => Math.min(12, Math.max(6, availableParallelism()));

/**
 * Run `tasks` with a bounded number in flight. Cloning 47 repos serially is
 * slow; cloning them all at once saturates the network and the SSH server.
 */
export async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
