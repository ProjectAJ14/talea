// Adopting repos the developer already has.
//
// Three situations are really one situation — a repo exists, but not where the
// catalogue says it should be:
//
//   1. cloned by hand somewhere ad-hoc      ~/Desktop/eklavya
//   2. a whole workspace in another shape   ~/code/bg/order-integrity
//   3. the catalogue itself moved it        old-owner/... -> new-owner/...
//
// In all three the right answer is to MOVE the existing checkout, never to
// clone a fresh copy beside it. A move keeps branches, stashes, reflog,
// remotes, the index and any uncommitted work. A re-clone throws all of that
// away, which is exactly the loss `CLAUDE.md` rule 2 exists to prevent.
//
// Nothing here deletes anything, ever. Every refusal leaves the repo where it
// is and says why.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { git, pooled } from './git.js';
import { repoUrl, repoDir, repoGroup } from './config.js';

// Directories that never contain a checkout we care about but do contain
// thousands of files. Skipping them is the difference between a scan that
// takes a second and one that walks a JVM target tree.
/** Git output is \n on POSIX but can be \r\n on Windows; a stray \r corrupts a
 * parsed SHA or path just enough to be baffling. */
export const lines = (text) => String(text).split(/\r?\n/).filter(Boolean);

const SCAN_SKIP = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  'Library',
  'Applications',
  'AppData',
  '$Recycle.Bin',
  'Windows',
]);

/**
 * Compare two paths the way the filesystem does.
 *
 * Windows and macOS are case-insensitive, so `C:\\Work\\Repo` and `c:\\work\\repo`
 * name the same directory. Comparing them as raw strings made a repo already
 * sitting at its catalogue path look like a stray copy — which would then be
 * "moved" onto itself, or parked as a duplicate of nothing.
 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const norm = (p) => (caseInsensitive ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/**
 * Reduce a git remote URL to something comparable.
 *
 * The same repo is reachable by genuinely different URLs — `git@github.com:me/x.git`,
 * `https://github.com/me/x`, `ssh://git@github.com/me/x.git`, and the same again
 * with or without the `.git`. This normalises away scheme, credentials, port,
 * percent-escapes, `.git` and case so that the forms that ARE the same compare
 * equal — otherwise a checkout cloned over HTTPS does not match a catalogue that
 * says SSH, and gets cloned a second time.
 */
export function normalizeUrl(url) {
  if (!url) return null;
  let s = String(url).trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // A malformed escape is not worth failing over; compare the raw form.
  }

  // A remote can be a plain filesystem path, and on Windows the same one
  // arrives spelled two ways: git prints `C:/dir`, Node hands back `C:\dir`.
  // Left alone they normalise to different strings, the checkout stops
  // matching its own catalogue entry, and talea clones a second copy of a
  // repo the developer already has. No real URL contains a backslash.
  s = s.replace(/\\/g, '/');

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme) s = s.slice(scheme[0].length);

  // Strip credentials: user@host or user:pass@host.
  s = s.replace(/^[^/@]*@/, '');

  if (scheme) {
    // Real URL: drop an explicit port.
    s = s.replace(/^([^/:]+):\d+/, '$1');
  } else {
    // scp-style `host:path` — the colon is a separator, not a port.
    s = s.replace(':', '/');
  }

  s = s
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');

  return s.toLowerCase();
}

/** The last path segment of a remote — the repo name as the server knows it. */
export function urlRepoName(url) {
  const n = normalizeUrl(url);
  return n ? (n.split('/').pop() ?? null) : null;
}

/** Every URL form the catalogue knows for this repo. */
export function catalogueUrls(manifest, repo) {
  const urls = [];
  if (repo.url) urls.push(repo.url);
  for (const protocol of Object.keys(manifest.remotes ?? {})) {
    try {
      urls.push(repoUrl(manifest, { ...repo, url: undefined }, protocol));
    } catch {
      // An unknown protocol in the manifest is `list`'s problem, not ours.
    }
  }
  return urls;
}

/**
 * Is this directory a linked worktree rather than a checkout of its own?
 *
 * A worktree's `.git` is a file holding a pointer, where a real checkout has a
 * directory. The distinction matters because a worktree reports the same
 * `origin` as the repo it belongs to, so by remote alone it is indistinguishable
 * from a second clone — and treating one as a stray copy is how you rename it
 * out from under git and unroot every commit in it.
 */
export function isLinkedWorktree(dir) {
  try {
    return lstatSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * Which catalogue repo does this remote belong to?
 *
 * `exact` — the normalised URL matches a form the catalogue knows.
 * `name`  — only the repo name matches, because the developer cloned from a
 *           host the catalogue does not list (a self-hosted mirror, a fork). Still
 *           almost certainly the right repo, but reported as the weaker match
 *           so a human sees it before anything moves.
 */
export function matchRepo(manifest, repos, originUrl) {
  const norm = normalizeUrl(originUrl);
  if (!norm) return null;

  for (const repo of repos) {
    if (catalogueUrls(manifest, repo).some((u) => normalizeUrl(u) === norm)) {
      return { repo, confidence: 'exact' };
    }
  }

  const name = urlRepoName(originUrl);
  for (const repo of repos) {
    if (name && repo.name.toLowerCase() === name) {
      return { repo, confidence: 'name' };
    }
  }
  return null;
}

/**
 * Find git checkouts under `roots`, without descending into them.
 *
 * Deliberately never scans $HOME on its own initiative: moving a developer's
 * repositories is not something to do off a guess about where they might be.
 * Callers pass the workspace root by default and anything else explicitly.
 */
export function findGitDirs(roots, maxDepth = 3) {
  const found = [];
  const visited = new Set();

  const walk = (dir, depth) => {
    if (visited.has(dir)) return;
    visited.add(dir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, a dead symlink) — not our business
    }

    if (entries.some((e) => e.name === '.git')) {
      found.push(dir);
      return; // a repo is a leaf; never look for repos inside one
    }
    if (depth >= maxDepth) return;

    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SCAN_SKIP.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  for (const root of roots) {
    const abs = path.resolve(root);
    if (existsSync(abs)) walk(abs, 0);
  }
  return found;
}

/** Read `origin` for each candidate directory, a few at a time. */
export async function readOrigins(dirs, jobs = 8) {
  // Return pooled's own index-ordered results. Pushing from inside the worker
  // ordered candidates by whichever `git` process happened to exit first, which
  // made the choice of "which copy is the real one" a coin flip.
  return pooled(dirs, jobs, async (dir) => {
    const { code, stdout } = await git(['remote', 'get-url', 'origin'], { cwd: dir });
    return { dir, originUrl: code === 0 ? stdout : null };
  });
}

/** Is the destination free? An existing non-empty directory belongs to the developer. */
function destinationBlocked(to) {
  if (!existsSync(to)) return null;
  let entries;
  try {
    entries = readdirSync(to);
  } catch {
    return 'destination exists and cannot be read';
  }
  return entries.length ? 'destination already exists and is not empty' : null;
}

/**
 * Reasons a checkout must not be moved. Each one is a case where `rename`
 * would leave git pointing at a path that no longer exists.
 */
async function moveBlockers(dir) {
  const dotGit = path.join(dir, '.git');
  try {
    if (lstatSync(dotGit).isFile()) {
      return 'this is a linked worktree (.git is a file) — move its main repo instead';
    }
  } catch {
    return 'no .git found';
  }

  return null;
}

/**
 * A path spelled the way the filesystem spells it.
 *
 * Two absolute paths to the same place compare unequal often enough to matter:
 * Windows hands Node the 8.3 short form out of TEMP (`VSSADM~1`) while git
 * prints the long one, and macOS symlinks /tmp to /private/tmp. `path.relative`
 * then reads a nested worktree as living somewhere else entirely, and every
 * repo with one is refused a move it could safely make. Found on windows-latest,
 * where it refused every repo with a `.claude/worktrees/x` in it.
 *
 * Realpath needs the path to exist. Worktree records outlive their directories,
 * so canonicalise the longest ancestor that does and re-attach the rest.
 */
export function canonical(p) {
  let dir = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(dir), ...tail);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(p);
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Every linked worktree of this repo, as git currently records it.
 *
 * `prunable` ones are skipped: git already knows the directory is gone, so
 * there is no path left to repair. `--porcelain` emits a blank-line-separated
 * block per worktree, the first being the main checkout — which is the repo
 * being moved, not a link into it.
 *
 * This used to return only the worktrees *outside* the repo, and a move was
 * refused when there were any. That was wrong: an external worktree does not
 * move, so nothing about it breaks except the pointer in its own `.git` file,
 * and `git worktree repair` exists to rewrite exactly that. Refusing meant a
 * developer who uses worktrees at all could never have their repos organised —
 * and it cascaded, because a refused winner leaves every duplicate of it
 * refused too.
 */
export function linkedWorktrees(porcelain) {
  return String(porcelain)
    .split(/\r?\n\s*\r?\n/)
    .map((block) => lines(block))
    .filter((block) => block.length && block[0].startsWith('worktree '))
    .slice(1) // the main checkout is the thing being moved, not a link into it
    .filter((block) => !block.some((l) => l === 'prunable' || l.startsWith('prunable ')))
    .map((block) => block[0].slice('worktree '.length));
}

/**
 * Where a worktree ends up once the repo has moved.
 *
 * Three cases, and the whole correctness of the repair is getting them right:
 *
 *  - inside the repo (`.claude/worktrees/x`) — travelled with the rename.
 *  - inside the sibling `<repo>-worktrees/` folder, when that folder was moved
 *    alongside — travelled too, to the new sibling.
 *  - anywhere else — did not move at all, and must be repaired where it sits.
 */
export function remapWorktree(p, { from, to, siblings }) {
  const within = (base) => {
    const rel = path.relative(canonical(base), canonical(p));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
  };

  const nested = within(from);
  if (nested) return path.join(to, nested);

  if (siblings) {
    const moved = within(siblings.from);
    if (moved) return path.join(siblings.to, moved);
  }

  return p;
}

/**
 * The sibling folder worktrees are conventionally kept in.
 *
 * `<repo>-worktrees/`, derived from the repo's own path rather than stored
 * anywhere — which is why it has to move when the repo does. Leave it behind
 * and the tooling that creates worktrees starts using a new empty folder next
 * to the moved repo while every existing worktree sits beside the old location.
 * Both halves keep working; the developer now has two.
 */
export const siblingWorktreeDir = (repoPath) => `${repoPath}-worktrees`;

/**
 * What a second copy holds that the copy being kept does not.
 *
 * Purely informational: nothing here decides whether the copy is touched, only
 * what the developer is told about it. An empty list means the copy is fully
 * redundant and can be thrown away at leisure; a non-empty one means there is
 * something in it worth looking at before it goes.
 */
export async function uniqueWork(loser, winner) {
  const blockers = [];

  const { stdout: dirty } = await git(['status', '--porcelain'], { cwd: loser });
  if (dirty) {
    const n = lines(dirty).length;
    blockers.push(`${n} uncommitted change${n > 1 ? 's' : ''}`);
  }

  const { stdout: stashes } = await git(['stash', 'list'], { cwd: loser });
  if (stashes) {
    const n = lines(stashes).length;
    blockers.push(`${n} stash${n > 1 ? 'es' : ''}`);
  }

  // Every local branch tip must already be an object the winner knows about.
  // Asked as one batched call: a long-lived checkout can have hundreds of local
  // branches, and one subprocess each is a visible stall before any output.
  const { stdout: heads } = await git(
    ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'],
    { cwd: loser },
  );
  const branches = lines(heads).map((line) => {
    const [name, sha] = line.split(' ');
    return { name, sha };
  });

  if (branches.length) {
    const { stdout: batch } = await git(['cat-file', '--batch-check'], {
      cwd: winner,
      input: branches.map((b) => b.sha).join('\n') + '\n',
    });
    // One line per input, in order: "<sha> commit <size>" or "<sha> missing".
    const checked = lines(batch);
    const missing = branches
      .filter((_, i) => !/\bcommit\b/.test(checked[i] ?? 'missing'))
      .map((b) => b.name);
    if (missing.length) {
      blockers.push(`commits the other copy does not have (${missing.join(', ')})`);
    }
  }

  return blockers;
}

/** Where second copies are parked. Dot-prefixed, so `findGitDirs` skips it —
 * without that, every run would find the parked copy and park it again. */
export const DUPLICATES_DIR = '.talea-duplicates';

/**
 * A free path under the duplicates area for this repo. Suffixed rather than
 * overwritten, because a second stray copy is not permission to bin the first.
 */
export function parkingSpot(root, repo, manifest) {
  // The group's configured dir, not its catalogue key — they are equal today,
  // and would silently diverge the first time one is not.
  const group = repoGroup(repo);
  const groupDir = manifest?.groups?.[group]?.dir ?? group;
  const base = path.join(root, DUPLICATES_DIR, groupDir, repo.dir ?? repo.name);
  if (!existsSync(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Turn candidate checkouts into a plan of what to move where.
 *
 * `repos` is the selected subset of the catalogue, so `talea clone -r foo`
 * only ever adopts foo.
 */
export async function planAdoptions(manifest, root, repos, candidates) {
  // Group every candidate by the catalogue repo it belongs to, so duplicates
  // are visible as duplicates rather than as two unrelated findings.
  const byRepo = new Map();
  for (const { dir, originUrl } of candidates) {
    const match = matchRepo(manifest, repos, originUrl);
    if (!match) continue;

    // A linked worktree shares its repo's origin, so it arrives here looking
    // exactly like a second clone. It is not one — it is part of the repo, and
    // it travels when the repo moves (see relocateWorktrees). Reporting one as
    // a stray copy produced a refusal line per worktree, which for a developer
    // who uses them buried the real findings under fifteen lines of noise.
    if (isLinkedWorktree(dir)) continue;

    const key = match.repo.name;
    if (!byRepo.has(key)) byRepo.set(key, { repo: match.repo, copies: [] });
    byRepo.get(key).copies.push({ dir, originUrl, confidence: match.confidence });
  }

  const plans = [];

  for (const { repo, copies } of byRepo.values()) {
    const to = repoDir(manifest, root, repo);

    // The directory structure decides the winner: a copy already sitting at the
    // catalogue path stays, and everything else is a duplicate of it. With no
    // copy there, the first one found is moved in and becomes the winner.
    // Order the copies so the winner is a decision, not an accident: a copy
    // already at the catalogue path first, then anything inside the workspace,
    // then by path so the result is stable across runs and machines.
    const rank = (copy) => {
      if (samePath(copy.dir, to)) return 0;
      const rel = path.relative(root, copy.dir);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? 1 : 2;
    };
    const ordered = [...copies].sort((a, b) => rank(a) - rank(b) || a.dir.localeCompare(b.dir));

    const atTarget = ordered.find((c) => samePath(c.dir, to));
    const winner = atTarget ?? ordered[0];
    const base = (copy) => ({ repo, from: copy.dir, to, confidence: copy.confidence, originUrl: copy.originUrl });

    // Where the winner will actually be once this run finishes. Duplicates are
    // checked against that path, not against where the winner sits right now —
    // it is about to move out from under them.
    let winnerEndsAt = to;

    if (atTarget) {
      plans.push({ ...base(atTarget), action: 'in-place' });
    } else {
      const blocked = destinationBlocked(to) ?? (await moveBlockers(winner.dir));
      if (blocked) {
        plans.push({ ...base(winner), action: 'refuse', reason: blocked });
        winnerEndsAt = null; // the winner is not going anywhere
      } else {
        plans.push({ ...base(winner), action: 'move' });
      }
    }

    for (const copy of ordered) {
      if (copy === winner) continue;

      // With the winner's own move refused, there is no settled copy to be
      // redundant against. Keep every duplicate until that is sorted out.
      if (winnerEndsAt === null) {
        plans.push({
          ...base(copy),
          action: 'refuse',
          reason: `a second copy, but ${path.relative(root, winner.dir) || winner.dir} could not be moved into place first`,
        });
        continue;
      }

      // Parking is still a move, so it needs every guard a move needs. A
      // `git worktree` of this repo shares its origin URL and therefore looks
      // exactly like a second copy — renaming one silently breaks the link
      // back to its main repo and leaves its commits unrooted.
      const blocked = await moveBlockers(copy.dir);
      if (blocked) {
        plans.push({ ...base(copy), action: 'refuse', reason: `a second copy, but ${blocked}` });
        continue;
      }

      // A second copy is never left lying outside the structure and never
      // deleted. It moves into the workspace's duplicates area, keeping
      // everything it holds, so the tree is tidy and nothing is lost.
      plans.push({
        ...base(copy),
        action: 'park',
        to: parkingSpot(root, repo, manifest),
        keeping: winnerEndsAt,
        holds: await uniqueWork(copy.dir, winner.dir),
      });
    }
  }

  return plans;
}

/**
 * Perform one relocation — into place, or into the duplicates area. `rename`
 * only: it is atomic, it preserves everything, and it cannot half-succeed. A
 * cross-device move is reported rather than turned into a copy, because
 * copying a multi-gigabyte .git and then deleting the original is precisely
 * the "destroy uncommitted work" failure this tool refuses to risk.
 *
 * There is no delete anywhere in this module. A copy that is not wanted is
 * moved aside, and the developer removes the duplicates area themselves.
 */
/**
 * What git records about this repo's worktrees, read BEFORE it moves.
 *
 * The ordering is load-bearing. Once the repo has moved, every worktree that
 * travelled with it is reported `prunable` — git looks for it at its recorded
 * location, which is the path that just stopped existing — and a prunable
 * entry is indistinguishable from a genuinely dead one. Read after the move
 * and the worktrees that most need repairing are exactly the ones filtered out.
 */
export function readWorktrees(dir) {
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return listed.status === 0 ? linkedWorktrees(listed.stdout) : [];
}

/**
 * Bring a repo's worktrees with it, then re-link every one of them.
 *
 * Every link between a repo and a worktree is an absolute path to where the
 * repo used to be, so a rename breaks all of them at once. `git worktree
 * repair` with no arguments cannot help: it looks for each worktree at its
 * recorded path, which is exactly the path that no longer exists. Handing it
 * the new paths is what the argument form is for.
 *
 * The sibling `<repo>-worktrees/` folder moves too. That location is derived
 * from the repo's own path at the moment a worktree is created, never stored,
 * so leaving it behind does not break anything — it silently splits the
 * workflow in half instead, new worktrees appearing next to the moved repo
 * while every existing one stays beside the old location. Splitting something
 * in two and reporting success is worse than refusing.
 *
 * Nothing is deleted and nothing is overwritten: an occupied destination means
 * the folder stays where it is, and the worktrees in it are repaired in place.
 */
function relocateWorktrees(from, to, recorded) {
  if (!recorded.length) return { repaired: [], siblings: null, stale: 0 };

  // The sibling folder moves only if it exists, is going somewhere new, and
  // that somewhere is free. Anything else and the worktrees stay put — still
  // correct, just not tidied.
  let siblings = null;
  const fromSiblings = siblingWorktreeDir(from);
  const toSiblings = siblingWorktreeDir(to);
  if (
    existsSync(fromSiblings) &&
    !samePath(fromSiblings, toSiblings) &&
    !existsSync(toSiblings)
  ) {
    try {
      mkdirSync(path.dirname(toSiblings), { recursive: true });
      renameSync(fromSiblings, toSiblings);
      siblings = { from: fromSiblings, to: toSiblings };
    } catch {
      // A cross-device sibling folder, or one being written to. The repo has
      // already moved and is fine; the worktrees are repaired where they are.
    }
  }

  const now = recorded
    .map((p) => remapWorktree(p, { from, to, siblings }))
    .filter((p) => existsSync(p));

  if (now.length) {
    spawnSync('git', ['worktree', 'repair', ...now], { cwd: to, stdio: 'ignore' });
  }
  return { repaired: now, siblings, stale: recorded.length - now.length };
}

export function executeMove(plan) {
  try {
    mkdirSync(path.dirname(plan.to), { recursive: true });
    // Read before the rename: see readWorktrees.
    const recorded = readWorktrees(plan.from);
    renameSync(plan.from, plan.to);
    const worktrees = relocateWorktrees(plan.from, plan.to, recorded);
    return { ok: true, to: plan.to, worktrees };
  } catch (err) {
    if (err.code === 'EXDEV') {
      const cmd = process.platform === 'win32' ? 'move' : 'mv';
      return {
        ok: false,
        message:
          `on a different filesystem — move it yourself, then re-run:\n` +
          `      ${cmd} "${plan.from}" "${plan.to}"`,
      };
    }
    // Windows refuses to rename a directory while any process holds a handle
    // inside it, which an open editor, terminal or virus scanner routinely
    // does. On POSIX the same rename would simply succeed, so the advice has
    // to name the real cause rather than the errno.
    if (['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'ENAMETOOLONG', 'EINVAL'].includes(err.code)) {
      return {
        ok: false,
        message:
          `could not be moved (${err.code}) — something has it open.\n` +
          `      Close any editor, terminal or file manager sitting in\n` +
          `      ${plan.from}\n      and run the command again.`,
      };
    }
    return { ok: false, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Repairing absolute paths that pointed at the old location.
//
// Scope here is deliberately narrow and was chosen by measuring a real
// machine, not by imagining what might break:
//
//   ~/.claude/projects/<slug>/   session history + memory, keyed by path slug
//   ~/.claude.json               per-project settings, keyed by absolute path
//   a short list of config files that are known to hold absolute paths
//
// Measured as NOT affected, and therefore not touched: claude-mem (keyed by
// project *name*, so a move is invisible to it), ~/.claude/settings.json,
// Cursor/VS Code settings.json, and the workspace .mcp.json. IDE "recent
// projects" state is left alone too — it self-heals, and writing it while the
// IDE is running loses the write.
// ---------------------------------------------------------------------------

/** How Claude Code names a project directory: every non-alphanumeric becomes `-`. */
export const claudeSlug = (p) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');

const claudeHome = () => path.join(os.homedir(), '.claude');

/**
 * Is a Claude Code process running? It holds ~/.claude.json in memory and
 * writes the whole file back when it exits, so an edit made underneath a live
 * session is silently reverted. Worth warning about; not worth blocking on.
 */
export function claudeMaybeRunning() {
  if (process.platform === 'win32') {
    const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return res.status === 0 && /claude\.exe/i.test(res.stdout ?? '');
  }
  const res = spawnSync('pgrep', ['-x', 'claude'], { stdio: 'pipe' });
  return res.status === 0;
}

/**
 * Move a project's session history and memory to its new path slug.
 * If a directory already exists for the new path (because someone worked there
 * before the move), the two are merged rather than either being replaced.
 */
export function moveClaudeSessions(from, to) {
  if (samePath(from, to)) return { changed: false };
  const oldDir = path.join(claudeHome(), 'projects', claudeSlug(from));
  const newDir = path.join(claudeHome(), 'projects', claudeSlug(to));
  if (!existsSync(oldDir)) return { changed: false };

  if (!existsSync(newDir)) {
    try {
      mkdirSync(path.dirname(newDir), { recursive: true });
      renameSync(oldDir, newDir);
      return { changed: true, merged: false, dir: newDir };
    } catch (err) {
      return { changed: false, error: err.message };
    }
  }

  // Merge: carry over anything the new location does not already have. Never
  // overwrite — a name collision means the new side has its own history.
  let moved = 0;
  let kept = 0;
  for (const entry of readdirSync(oldDir)) {
    const src = path.join(oldDir, entry);
    const dest = path.join(newDir, entry);
    if (existsSync(dest)) {
      kept++;
      continue;
    }
    try {
      renameSync(src, dest);
      moved++;
    } catch {
      kept++;
    }
  }
  return { changed: moved > 0, merged: true, moved, kept, dir: newDir, leftBehind: oldDir };
}

/** Write JSON through a temp file so a crash can never leave it truncated. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.talea-tmp`;
  try {
    writeAtomicInner(file, tmp, data);
  } catch (err) {
    // Windows can refuse the rename while another process holds the file open —
    // exactly what claudeMaybeRunning() warns about. Do not leave litter next
    // to the developer's config.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing further to try.
    }
    throw err;
  }
}

function writeAtomicInner(file, tmp, data) {
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  // Carry the original mode across. ~/.claude.json holds account data and a
  // developer may well have chmod 600'd it; a fresh temp file would default to
  // 0644 and quietly widen it on the rename.
  try {
    chmodSync(tmp, statSync(file).mode & 0o777);
  } catch {
    // No original to copy from, or a filesystem without modes — not fatal.
  }
  renameSync(tmp, file);
}

/**
 * Re-key this project's entry in ~/.claude.json from the old path to the new.
 * An entry already present at the new path wins — it is the newer of the two.
 */
export function rekeyClaudeJson(from, to) {
  // Same path in and out: there is nothing to re-key. Without this the
  // "already an entry at the new path" branch below deletes the live one.
  if (samePath(from, to)) return { changed: false };

  const file = path.join(os.homedir(), '.claude.json');
  if (!existsSync(file)) return { changed: false };

  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { changed: false, error: `could not parse ~/.claude.json (${err.message})` };
  }
  if (!data?.projects) return { changed: false };

  const oldKey = path.resolve(from);
  const newKey = path.resolve(to);
  if (!(oldKey in data.projects)) return { changed: false };

  if (newKey in data.projects) {
    delete data.projects[oldKey];
    try {
      writeJsonAtomic(file, data);
      return { changed: true, note: 'dropped the stale entry; the new path already had one' };
    } catch (err) {
      return { changed: false, error: err.message };
    }
  }

  data.projects[newKey] = data.projects[oldKey];
  delete data.projects[oldKey];
  try {
    writeJsonAtomic(file, data);
    return { changed: true };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}

// Files known to carry absolute paths, checked in the workspace root and in
// the repo's new home. The list is measured, not guessed: everything here was
// found holding a real absolute path on a working developer machine, or is the
// documented place a tool keeps one.
//
// Deliberately absent, with reasons, in `unfixablePaths()` below.
const CONFIG_BY_NAME = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  '.mcp.json',
  '.envrc',
  'bruno.json',
  '.cursorrules',
]);

const CONFIG_BY_PATTERN = [
  /\.code-workspace$/,
  /^\.env(\..+)?$/,
  /^docker-compose.*\.ya?ml$/,
];

// Config directories, searched recursively — `.idea/runConfigurations/*.xml`
// and `.claude/commands/*.md` are both a level down, and a flat glob missed
// them.
const CONFIG_SUBDIRS = {
  '.idea': /\.(xml|iml)$/,
  '.vscode': /\.(json|code-snippets)$/,
  '.claude': /\.(json|md)$/,
  '.devcontainer': /\.json$/,
  '.cursor': /\.(json|mdc)$/,
};

// Never rewritten even when it matches: .talea.json records `adopted[].from`,
// the literal old path, which is the record `--fix-paths` replays from.
const NEVER_REWRITE = new Set(['.talea.json']);

function walkConfigDir(dir, pattern, depth = 0) {
  const found = [];
  if (depth > 2 || !existsSync(dir)) return found;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkConfigDir(full, pattern, depth + 1));
    else if (pattern.test(entry.name)) found.push(full);
  }
  return found;
}

function configFilesUnder(dir) {
  const files = [];
  if (!existsSync(dir)) return files;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (NEVER_REWRITE.has(entry.name)) continue;
      if (CONFIG_BY_NAME.has(entry.name) || CONFIG_BY_PATTERN.some((re) => re.test(entry.name))) {
        files.push(path.join(dir, entry.name));
      }
    }
  } catch {
    // unreadable directory — nothing to offer
  }

  for (const [sub, pattern] of Object.entries(CONFIG_SUBDIRS)) {
    files.push(...walkConfigDir(path.join(dir, sub), pattern));
  }
  return files;
}

/**
 * The spellings one absolute path takes across config files.
 *
 * On Windows the same directory is written `C:\\src\\repo` by one tool,
 * `C:/src/repo` by another (JetBrains, and anything that just uses forward
 * slashes), and `C:\\\\src\\\\repo` inside JSON, where the backslash is escaped.
 * Shell startup files write `~/src/repo` or `$HOME/src/repo` — which is how a
 * broken `cd` alias went unnoticed until it was looked for directly.
 *
 * Keyed by kind, so a rewrite can pair like with like: a `$HOME`-relative
 * reference is replaced by a `$HOME`-relative one, not by an absolute path.
 */
function spellingsOf(p) {
  const native = path.resolve(p);
  const forms = {
    native,
    forward: native.split('\\').join('/'),
    jsonEscaped: native.split('\\').join('\\\\'),
  };

  const home = os.homedir();
  if (home && native.startsWith(home + path.sep)) {
    const rest = native.slice(home.length).split('\\').join('/');
    forms.tilde = `~${rest}`;
    forms.homeVar = `$HOME${rest}`;
  }
  return forms;
}

/** Every distinct spelling, longest first. Used to find references. */
export function pathSpellings(p) {
  return [...new Set(Object.values(spellingsOf(p)))].sort((a, b) => b.length - a.length);
}

/**
 * Matched from/to spellings for a rewrite, paired by kind rather than by
 * position — sorting two independent lists by length can pair a `~` form on one
 * side with an absolute form on the other. A kind present on only one side is
 * dropped: not rewriting beats rewriting into the wrong shape.
 */
export function pathSpellingPairs(from, to) {
  const f = spellingsOf(from);
  const t = spellingsOf(to);
  const seen = new Set();
  return Object.keys(f)
    .filter((kind) => t[kind] !== undefined)
    .map((kind) => ({ from: f[kind], to: t[kind] }))
    .filter((pair) => {
      if (seen.has(pair.from)) return false;
      seen.add(pair.from);
      return true;
    })
    .sort((a, b) => b.from.length - a.from.length);
}

// Characters that can continue a path segment. If one of these follows a match,
// the match was a prefix of a longer path, not the path itself — the catalogue
// really does contain `V2/CEP-ONLINE-PORTAL-V2` alongside
// `V2/CEP-ONLINE-PORTAL-V2-UI`, and rewriting the first inside the second points
// an IDE at a directory that does not exist.
const CONTINUES_PATH = /[A-Za-z0-9_.\-~+@]/;

const atBoundary = (text, index, length) => {
  const next = text[index + length];
  return next === undefined || !CONTINUES_PATH.test(next);
};

/** Replace `needle` with `replacement`, but only where it is a whole path. */
export function replaceAtBoundary(text, needle, replacement) {
  if (!needle) return text;
  let out = '';
  let i = 0;
  for (;;) {
    const at = text.indexOf(needle, i);
    if (at === -1) return out + text.slice(i);
    out += text.slice(i, at);
    out += atBoundary(text, at, needle.length) ? replacement : needle;
    i = at + needle.length;
  }
}

/** How many whole-path occurrences of `needle` are in `text`. */
export function countAtBoundary(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = text.indexOf(needle, i);
    if (at === -1) return n;
    if (atBoundary(text, at, needle.length)) n++;
    i = at + needle.length;
  }
}

/** Config files that contain the old absolute path, in any of its spellings. */
export function findConfigHits(dirs, from) {
  const needles = pathSpellings(from);
  const hits = [];
  for (const file of new Set(dirs.flatMap(configFilesUnder))) {
    try {
      const text = readFileSync(file, 'utf8');
      const count = needles.reduce((n, needle) => n + countAtBoundary(text, needle), 0);
      if (count > 0) hits.push({ file, count });
    } catch {
      // binary or unreadable — not something to rewrite blind
    }
  }
  return hits;
}

/** Literal, non-regex replacement of one absolute path with another. */
export function rewriteConfigFile(file, from, to) {
  try {
    const text = readFileSync(file, 'utf8');
    let next = text;
    for (const pair of pathSpellingPairs(from, to)) {
      next = replaceAtBoundary(next, pair.from, pair.to);
    }
    if (next === text) return { changed: false };
    writeFileSync(file, next);
    return { changed: true };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}


/**
 * Places that still hold the old path and that this tool will NOT rewrite.
 *
 * Each was measured on a real machine. The rule for being on this list rather
 * than being fixed: it is a log, a cache, a historical record, or it is keyed
 * by something we cannot recompute. Rewriting a log rewrites history;
 * rewriting a cache is pointless; and a hash-keyed store cannot be renamed
 * without reproducing the hash.
 */
export function unfixablePaths(from) {
  const home = os.homedir();
  const needles = pathSpellings(from);
  const out = [];

  const countIn = (file) => {
    try {
      const text = readFileSync(file, 'utf8');
      return needles.reduce((n, needle) => n + countAtBoundary(text, needle), 0);
    } catch {
      return 0;
    }
  };

  // Shell startup files: `cd` aliases pointing at the old location. Not
  // rewritten because a bad edit to a login shell config breaks every new
  // terminal — but reported with the line numbers, because a stale alias here
  // is the failure a developer actually notices first.
  for (const name of ['.zshrc', '.bashrc', '.bash_profile', '.zprofile', '.profile', '.zshenv']) {
    const file = path.join(home, name);
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const hits = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (needles.some((needle) => countAtBoundary(line, needle) > 0)) hits.push(i + 1);
    });
    if (hits.length) {
      out.push({
        what: `~/${name}`,
        detail: `line${hits.length > 1 ? 's' : ''} ${hits.join(', ')}`,
        why: 'shell aliases — edit by hand; a bad edit here breaks every new terminal',
        actionable: true,
      });
    }
  }

  const note = (rel, why) => {
    const file = path.join(home, rel);
    if (existsSync(file) && countIn(file) > 0) out.push({ what: `~/${rel}`, why, actionable: false });
  };
  note('.claude/history.jsonl', 'a log of commands you ran — rewriting it rewrites history');

  return out;
}
