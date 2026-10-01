// Removing worktrees whose work is already on origin.
//
// The only command that deletes anything, so the rules are narrow and every
// one of them is git's rather than ours: the removal is `git worktree remove`
// without --force, which refuses a tree with modified or untracked files by
// itself; a worktree is only offered when every commit on it is already on
// origin's default branch; and nothing happens without --apply. The branch is
// never deleted — it costs nothing, and `git worktree add` brings the checkout
// back. What a removal really frees is node_modules, build and .dart_tool.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { worktreeRecords, lines } from '../adopt.js';
import { defaultBranch, groupDir, repoGroup } from '../config.js';
import { defaultJobs, fetch, git, isDirty, pooled } from '../git.js';
import { task } from '../live.js';
import { c, context, fail, group, heading, plain, skip, summary, table, warn } from '../log.js';
import { clonedOnly, machineRepos, requireWorkspace, selectRepos, withPaths } from '../workspace.js';

export const help = `
${c.bold('talea prune')} — remove worktrees whose work is already merged

  ${c.dim('talea prune')}                     show the plan; changes nothing
  ${c.dim('talea prune --apply')}             remove what the plan marked
  ${c.dim('talea prune eklavya')}             only that repo's worktrees
  ${c.dim('talea prune --all')}               the whole catalogue, not just this machine

Every linked worktree of every cloned repo gets one verdict. Worktrees
outside the workspace count too — they belong to the repo.

  merged     every commit is on origin/<default branch>   ${c.dim('→ removed')}
  missing    its folder is already gone                   ${c.dim('→ record cleared')}
  dirty      modified or untracked files                  ${c.dim('→ kept')}
  ignored    merged, but holds ignored files you made     ${c.dim('→ kept')}
  nested     merged, but a repo inside has its own work   ${c.dim('→ kept')}
  unused     no commits of its own, untouched for a day   ${c.dim('→ removed')}
  fresh      the same, but cut less than a day ago        ${c.dim('→ kept')}
  locked     \`git worktree lock\`ed                        ${c.dim('→ kept')}
  unmerged   anything else                                ${c.dim('→ kept')}

"Merged" means the commit is on the default branch, or an identical change is
(a rebase merge). A ${c.bold('squash merge')} is neither, so it reads as unmerged
and is kept — delete that worktree yourself.

The removal is \`git worktree remove\`, never forced: git itself refuses a tree
with uncommitted work. The ${c.bold('branch is kept')}; only the folder goes, and
\`git worktree add\` brings it back. git deletes ignored files without asking,
so a merged worktree holding ignored files that are not build output — a
.env, notes — is kept as ${c.bold('ignored')} and the plan names them. Move them out, or
add --with-ignored to remove them along with the folder. A file identical to
the main checkout's copy at the same path is not counted: it survives. Nor is
build output: talea ships a list (node_modules, build, Flutter's ephemeral,
*.iml, …) in git's attributes syntax, and a repo marks its own in
.gitattributes, on the worktree's branch or on origin's default:

  web/public/runtime.html talea-regenerable
  generated/** talea-regenerable
  pubspec.lock -talea-regenerable     ${c.dim("take one of talea's back")}

A pattern for every repo on this machine goes in git's global attributes file
(\`git config --global core.attributesFile\`).

A repo inside a worktree — a build tool's clone, a nested worktree — goes with
it, so it is judged too: a linked worktree, uncommitted changes, a stash, or a
commit no remote has keeps the worktree as ${c.bold('nested')}, and the verdict says
why (\`nested · 1 dirty\`). A clean one whose commits are all on a remote does
not; its own ignored files are judged like the worktree's.

The table shows each worktree's folder name; its full path is the dim line
under the row.

A branch that has never moved since it was created has no commits yet, so it
looks merged. Cut in the last day it is a task just started: ${c.bold('fresh')}, kept.
Older, it is ${c.bold('unused')} and removed like a merged one. The verdict shows its age.

A lock is kept unless it is a leftover: Claude Code locks each agent worktree
with \`claude agent <id> (pid N start <time>)\`, and when that process has
exited the lock protects nothing. Such a worktree is judged as if unlocked
and the verdict says ${c.bold('stale lock')}; --apply unlocks it before removing it.
Any other lock is never touched. The lock's reason is on the dim line.

A repo with no default branch recorded is skipped: run \`talea discover\`.

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names; a bare name works too
      --all             ignore this machine's selection
      --apply           actually remove; without it nothing changes
      --with-ignored    also remove merged worktrees holding ignored files
`;

// Ignored paths that a build, an install or an IDE puts back, as an attributes
// file git matches itself. Anything ignored and NOT marked there, or by the
// repo, is somebody's file, and the plan names it before removal. A new
// ecosystem is new lines in that file, never new code.
const DEFAULTS = fileURLToPath(new URL('../regenerable.gitattributes', import.meta.url));
// A folded folder (`node_modules/`) is asked about through a path two levels
// inside it: `**/node_modules/**` marks that, and so covers the whole folder
// without listing it, while a pattern for only some of its files does not, and
// the folder is opened and judged file by file.
const PROBE = '.talea-probe/.talea-probe';

const IGNORED = ['ls-files', '--others', '--ignored', '--exclude-standard'];
// Past this many files a folder is named as one entry rather than compared
// file by file; it is somebody's folder either way.
const EXPAND_MAX = 200;

/**
 * The entries of `paths` nothing marks `talea-regenerable` — a `.gitattributes`
 * line such as `web/public/runtime.html talea-regenerable`.
 *
 * A file a build copies out of tracked source has no telltale folder, and the
 * main checkout's copy of it is as stale as its last build, so the repo can say
 * so. Asked three ways: the worktree's own attributes (with `.git/info/` and
 * the developer's global file), origin's default branch's — a merged worktree
 * was branched before the line landed, and the repo's current word is the one
 * that counts — and talea's defaults, given as the global file so a repo's
 * `-talea-regenerable` still wins over them. `--source` needs git 2.40; an
 * older git skips that one reading.
 */
async function unmarked(wtPath, base, paths) {
  if (!paths.length) return [];
  const asked = paths.map((p) => (p.endsWith('/') ? p + PROBE : p));
  const marked = new Set();
  const reads = [['check-attr'], ['check-attr', '--source', base], ['-c', `core.attributesFile=${DEFAULTS}`, 'check-attr']];
  for (const read of reads) {
    const res = await git([...read, '-z', '--stdin', 'talea-regenerable'], { cwd: wtPath, input: asked.join('\0') });
    if (res.code !== 0) continue;
    const out = res.stdout.split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'set') marked.add(out[i]);
  }
  return paths.filter((_, i) => !marked.has(asked[i]));
}

/**
 * The ignored files in a worktree that removing it would really lose.
 *
 * `--directory` folds a wholly-ignored folder into one entry, so a `.claude/`
 * holding nothing but the seeded settings file read as somebody's work — the
 * folder is opened and its files judged one by one. A file marked
 * `talea-regenerable` is build output by its own say. And a file byte-identical
 * to the main checkout's copy at the same path (a generated `tokens.css`, a
 * copied config) survives the removal, so it is not a loss either.
 *
 * `cleared` names the repos inside it (`vendor/dep/`, as git lists them) that
 * `nestedLoss()` found nothing in: their tracked files are on their remote, so
 * only their own ignored files count — judged the same way, with no main
 * checkout to compare against.
 */
export async function userIgnored(wtPath, mainDir, base, cleared = new Set()) {
  const listed = await git([...IGNORED, '--directory'], { cwd: wtPath });
  const lost = [];
  for (const entry of await unmarked(wtPath, base, lines(listed.stdout))) {
    const folder = entry.endsWith('/');
    const files = folder
      ? await unmarked(wtPath, base, lines((await git([...IGNORED, '--', entry], { cwd: wtPath })).stdout))
      : [entry];
    if (!files.length) continue;
    if (folder && files.length > EXPAND_MAX) {
      lost.push(entry);
      continue;
    }
    for (const f of files) {
      if (cleared.has(f)) {
        for (const g of await userIgnored(path.join(wtPath, f), null, 'HEAD')) lost.push(f + g);
      } else if (f.endsWith('/') || !(mainDir && (await sameFile(path.join(wtPath, f), path.join(mainDir, f))))) {
        lost.push(f);
      }
    }
  }
  return lost;
}

/** Two regular files with the same bytes. A symlink or anything unreadable is not "same". */
async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([lstat(a), lstat(b)]);
    // Sizes first: a multi-gigabyte ignored file that differs is never read.
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    const [x, y] = await Promise.all([readFile(a), readFile(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}

/**
 * What a repo found inside a worktree would lose with it, or null for nothing.
 *
 * `git worktree remove` deletes whatever is in the folder, nested repos too, so
 * one with work of its own keeps the worktree. But build tools write clean
 * clones everywhere — SwiftPM's `checkouts/`, Cargo git dependencies — and
 * judging those by where they sit kept every merged Flutter worktree that had
 * ever built for iOS. So it is judged by what it holds, the same for any tool:
 * a `.git` file is a linked worktree or a submodule, whose work lives in
 * another repo's records — the case this check was written for — and is always
 * a loss. Otherwise uncommitted changes, a stash, or a commit on HEAD or a
 * local branch that no remote has. Anything git cannot read is a loss too.
 */
export async function nestedLoss(dir) {
  if (!(await lstat(path.join(dir, '.git'))).isDirectory()) return 'worktree';
  // A broken `.git` must not send git up to the outer worktree's records.
  const opts = { cwd: dir, env: { GIT_CEILING_DIRECTORIES: path.dirname(dir) } };
  const status = await git(['status', '--porcelain', '-unormal'], opts);
  if (status.code !== 0) return 'unreadable';
  if (status.stdout) return 'dirty';
  if ((await git(['rev-parse', '--verify', '--quiet', 'refs/stash'], opts)).code === 0) return 'stash';
  const unpushed = await git(['rev-list', '-n1', 'HEAD', '--branches', '--not', '--remotes'], opts);
  return unpushed.code !== 0 || unpushed.stdout ? 'unpushed' : null;
}

/**
 * Bytes on disk under `root`, symlinks not followed, and every folder below
 * the root that has a `.git` of its own — another worktree or checkout.
 *
 * The second half is a safety check, not a statistic. git reads a worktree as
 * clean when the only thing in it is a nested worktree under an ignored path
 * (`.claude/worktrees/x`), and `git worktree remove` then deletes the nested
 * one with its uncommitted work. So every repo inside it is found, and
 * `nestedLoss()` says whether it holds anything.
 */
// ponytail: hardlinks (a pnpm store) count once per link, so the figure can
// overstate what is freed; dedupe by inode if that ever misleads anybody.
export async function measure(root) {
  const nested = [];
  const walk = async (dir) => {
    let st;
    try {
      st = await lstat(dir);
    } catch {
      return 0;
    }
    // Windows reports `blocks: 0` for every file, not undefined, so a null
    // check measured every worktree there as empty.
    const own = st.blocks ? st.blocks * 512 : st.size;
    if (!st.isDirectory()) return own;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return own;
    }
    if (dir !== root && names.includes('.git')) nested.push(dir);
    const sizes = await Promise.all(names.map((n) => walk(path.join(dir, n))));
    return sizes.reduce((a, b) => a + b, own);
  };
  const size = await walk(root);
  return { size, nested };
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

// Removed by --apply. Everything else is kept.
const REMOVABLE = new Set(['merged', 'unused']);
// How long a branch with no commits counts as a task just started.
const FRESH_FOR = 24 * 3600;

/**
 * One worktree's verdict, and for a branch with no commits, its age in
 * seconds. A held lock is decided by the caller, before this is reached.
 */
async function judge(repoDir, wt, base, now) {
  if (wt.prunable || !existsSync(wt.path)) return { verdict: 'missing' };
  if (await isDirty(wt.path)) return { verdict: 'dirty' };
  if (!(await isMerged(repoDir, wt.head, base))) return { verdict: 'unmerged' };
  // A branch with no commits of its own is trivially "merged". Cut a minute
  // ago it is a task just started; cut days ago and never touched, with the
  // folder clean, it is a task nobody started, and nothing goes with it. Its
  // reflog still holds only the creation entry; any commit, reset or pull adds one.
  if (wt.branch) {
    const log = await git(['reflog', 'show', '--format=%ct', `refs/heads/${wt.branch}`], { cwd: repoDir });
    const entries = lines(log.stdout);
    if (log.code === 0 && entries.length === 1) {
      const age = Math.max(0, Math.floor(now / 1000) - Number(entries[0]));
      return { verdict: age < FRESH_FOR ? 'fresh' : 'unused', age };
    }
  }
  return { verdict: 'merged' };
}

// Claude Code locks the worktree it makes for each agent with the agent's pid
// and that process's start time, as `ps -o lstart` prints it:
//   claude agent agent-a080e8ffc88a848e9 (pid 27815 start Wed Sep 30 20:22:41 2026)
const AGENT_LOCK = /^claude agent \S+ \(pid (\d+) start (.+)\)$/;

/** `ps`'s start time for a pid, or '' when it cannot say (no `ps`, as on Windows). */
const processStart = (pid) =>
  new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (_err, out) => resolve(String(out).trim()));
  });

/**
 * True when a lock is a leftover: it names an agent process that has exited.
 * Any other reason — one typed into `git worktree lock --reason`, or none — is
 * somebody's, and never stale. A live pid is stale only if it was reused: both
 * start times parse and differ. Anything this cannot read reads as held.
 */
export async function staleLock(reason, { started = processStart, kill = (pid, sig) => process.kill(pid, sig) } = {}) {
  const m = AGENT_LOCK.exec(reason ?? '');
  if (!m) return false;
  const pid = Number(m[1]);
  try {
    kill(pid, 0); // signal 0 sends nothing; it only asks whether the pid exists
  } catch (e) {
    // EPERM: it exists, owned by somebody else.
    return e.code === 'ESRCH';
  }
  const want = Date.parse(m[2]);
  const have = Date.parse(await started(pid));
  return !Number.isNaN(want) && !Number.isNaN(have) && want !== have;
}

/** 12m, 7h, 3d. */
export function formatAge(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

async function isMerged(repoDir, head, base) {
  const ancestor = await git(['merge-base', '--is-ancestor', head, base], { cwd: repoDir });
  if (ancestor.code === 0) return true;
  // A rebase merge rewrote every commit, so none is an ancestor — but each one
  // has a patch-identical twin on the base, and `cherry` marks those with `-`.
  const cherry = await git(['cherry', base, head], { cwd: repoDir });
  return cherry.code === 0 && !lines(cherry.stdout).some((l) => l.startsWith('+'));
}

/**
 * Fetch, then judge every linked worktree of one repo against its default
 * branch. `{ skip }` or `{ fail }` for a repo that cannot be judged, otherwise
 * `{ base, worktrees: [{ path, branch, verdict, age, stale, lockReason, size, lossy, held }] }`.
 * `withIgnored` lets a merged worktree go even with lossy ignored files in it;
 * `now` is the clock `fresh` is measured against.
 */
export async function planRepo({ repo, dir }, { withIgnored = false, now = Date.now() } = {}) {
  const listed = await git(['worktree', 'list', '--porcelain'], { cwd: dir });
  if (listed.code !== 0) return { fail: `git worktree list failed: ${listed.stderr}` };
  // The first record is the main checkout. It is the repo, and never a candidate.
  const linked = worktreeRecords(listed.stdout).slice(1);
  // Most repos have none; they need no fetch and have nothing to say.
  if (!linked.length) return { base: null, worktrees: [] };

  const home = defaultBranch(repo);
  // Rule 8: judged against a guessed `main`, a repo whose default is `develop`
  // would have every worktree cut from develop called unmerged — or worse.
  if (!home) return { skip: 'no default branch recorded — run `talea discover`' };

  const fetched = await fetch(dir);
  if (fetched.code !== 0) {
    return { fail: `fetch failed: ${fetched.stderr.split('\n').pop() || 'unknown error'}` };
  }
  const base = `origin/${home}`;
  const known = await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: dir });
  if (known.code !== 0) return { skip: `${base} does not exist` };

  const worktrees = [];
  for (const wt of linked) {
    // A lock is never second-guessed except a leftover one (see staleLock).
    const stale = wt.locked && (await staleLock(wt.lockReason));
    let { verdict, age } = wt.locked && !stale ? { verdict: 'locked' } : await judge(dir, wt, base, now);
    const { size, nested } = verdict === 'missing' ? { size: 0, nested: [] } : await measure(wt.path);
    const held = [];
    const cleared = new Set();
    if (REMOVABLE.has(verdict)) {
      // The walk is parallel, so its order is not; the report should be.
      for (const n of nested.sort()) {
        // git's spelling, so it matches what `ls-files` lists on any platform.
        const rel = path.relative(wt.path, n).split(path.sep).join('/');
        const why = await nestedLoss(n);
        if (why) held.push({ path: rel, why });
        else cleared.add(`${rel}/`);
      }
      if (held.length) verdict = 'nested';
    }
    let lossy = [];
    if (REMOVABLE.has(verdict)) {
      lossy = await userIgnored(wt.path, dir, base, cleared);
      // git deletes ignored files without asking, and `--apply` plans and
      // removes in one run — so a warning here would arrive after the loss.
      if (lossy.length && !withIgnored) verdict = 'ignored';
    }
    worktrees.push({ path: wt.path, branch: wt.branch, verdict, age, stale, lockReason: wt.lockReason, size, lossy, held });
  }
  return { base, worktrees };
}

/**
 * Carry out one repo's plan. Mutates each worktree's `verdict` to what
 * happened — `removed`, `cleared`, or `failed` with an `error`.
 */
export async function applyRepo(dir, plan) {
  // A stale lock is lifted first: `remove` and `prune` both skip a locked
  // record, and lifting it is what keeps the removal unforced.
  const unlock = async (wt) => {
    if (!wt.stale) return true;
    const res = await git(['worktree', 'unlock', wt.path], { cwd: dir });
    if (res.code !== 0) Object.assign(wt, { verdict: 'failed', error: `git worktree unlock failed: ${res.stderr}` });
    return res.code === 0;
  };
  for (const wt of plan.worktrees) {
    if (!REMOVABLE.has(wt.verdict) || !(await unlock(wt))) continue;
    // Never --force: git refusing is the last guard on uncommitted work.
    const res = await git(['worktree', 'remove', wt.path], { cwd: dir });
    if (res.code === 0) wt.verdict = 'removed';
    else Object.assign(wt, { verdict: 'failed', error: res.stderr || 'git refused' });
  }
  for (const wt of plan.worktrees) if (wt.verdict === 'missing') await unlock(wt);
  if (plan.worktrees.some((w) => w.verdict === 'missing')) {
    const res = await git(['worktree', 'prune'], { cwd: dir });
    for (const wt of plan.worktrees) {
      if (wt.verdict !== 'missing') continue;
      if (res.code === 0) wt.verdict = 'cleared';
      else Object.assign(wt, { verdict: 'failed', error: res.stderr || 'git worktree prune failed' });
    }
  }
  return plan;
}

const PAINT = {
  merged: c.green,
  unused: c.green,
  removed: c.green,
  missing: c.yellow,
  cleared: c.green,
  dirty: c.yellow,
  ignored: c.yellow,
  nested: c.yellow,
  fresh: c.cyan,
  locked: c.cyan,
  unmerged: c.dim,
  failed: c.red,
};

const listFiles = (files) =>
  `${files.length === 1 ? 'file' : 'files'}: ${files.slice(0, 3).join(', ')}` +
  (files.length > 3 ? c.dim(` and ${files.length - 3} more`) : '');

/** The facts beside a verdict: a no-commit branch's age, a lock left by an exited agent, what a nested repo holds. */
function verdictNote(wt) {
  const counts = {};
  for (const { why } of wt.held) counts[why] = (counts[why] ?? 0) + 1;
  const notes = [
    wt.age == null ? null : formatAge(wt.age),
    wt.stale ? 'stale lock' : null,
    ...Object.entries(counts).map(([why, n]) => `${n} ${why}`),
  ].filter(Boolean);
  return notes.length ? c.dim(` · ${notes.join(' · ')}`) : '';
}

function tilde(p) {
  const home = os.homedir().replace(/\\/g, '/');
  const norm = p.replace(/\\/g, '/');
  return norm === home || norm.startsWith(`${home}/`) ? `~${norm.slice(home.length)}` : p;
}

export async function run(opts) {
  const { root, manifest, state } = await requireWorkspace();
  const pool = opts.all ? manifest.repos.filter((r) => !r.ignore) : machineRepos(manifest, state);
  // -r reaches past the selection, but never past `ignore: true` (rule 4).
  const entries = clonedOnly(
    withPaths(manifest, root, selectRepos(manifest, opts, pool).filter((r) => !r.ignore)),
  );

  // A fetch per repo that has worktrees, then a walk of every worktree's files:
  // seconds on a real machine, and a silent terminal reads as a hang.
  let checked = 0;
  const plans = await task(
    opts.apply ? 'Pruning worktrees' : 'Checking worktrees',
    (update) =>
      pooled(entries, opts.jobs ?? defaultJobs(), async (entry) => {
        const plan = await planRepo(entry, { withIgnored: opts['with-ignored'] });
        if (opts.apply && plan.worktrees) await applyRepo(entry.dir, plan);
        update(`${++checked}/${entries.length}  ${entry.repo.name}`);
        return { ...entry, plan };
      }),
  );

  heading(opts.apply ? 'Pruning worktrees' : 'Worktrees — dry run, nothing changes');
  context([
    ['root', c.bold(root)],
    ['repos', `${entries.length}`],
  ]);
  plain('');

  let skipped = 0;
  let failed = 0;
  for (const { repo, plan } of plans) {
    if (plan.skip) {
      skipped++;
      skip(`${repo.name} — ${plan.skip}`);
    } else if (plan.fail) {
      failed++;
      fail(`${repo.name} — ${plan.fail}`);
    }
  }
  if (skipped || failed) plain('');

  const rows = plans.flatMap(({ repo, plan }) => (plan.worktrees ?? []).map((wt) => ({ repo, wt })));
  if (rows.length === 0) {
    plain(c.dim('No linked worktrees.'));
    summary({ ok: 0, skipped, failed });
    return;
  }

  const byGroup = new Map();
  for (const row of rows) {
    const g = repoGroup(row.repo);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(row);
  }

  for (const [name, groupRows] of byGroup) {
    group(`${groupDir(manifest, name)}/`, groupRows.length, 'worktree');
    // The folder name on the row, the full path dim underneath: the path is
    // what you paste, but as a column it pushed every other one off the screen.
    table(
      groupRows.map(({ repo, wt }) => [
        '  ' + c.bold(repo.name),
        path.basename(wt.path),
        wt.branch ?? c.dim('(detached)'),
        PAINT[wt.verdict](wt.verdict) + verdictNote(wt),
        wt.size ? formatBytes(wt.size) : c.dim('—'),
      ]),
      ['  REPO', 'WORKTREE', 'BRANCH', 'VERDICT', 'SIZE'],
      { below: groupRows.map(({ wt }) => tilde(wt.path) + (wt.lockReason ? `  — locked: ${wt.lockReason}` : '')) },
    );
    for (const { repo, wt } of groupRows) {
      const name = `${repo.name}/${path.basename(wt.path)}`;
      if (wt.error) fail(`${name} — ${wt.error}`);
      if (wt.verdict === 'nested') {
        const repos = wt.held.map((h) => `${h.path} (${h.why})`);
        warn(`${name} is merged, kept for ${repos.length === 1 ? 'a repo' : 'repos'} inside it: ${repos.slice(0, 3).join(', ')}` +
          (repos.length > 3 ? c.dim(` and ${repos.length - 3} more`) : ''));
      } else if (wt.verdict === 'ignored') {
        warn(`${name} is merged, kept for ignored ${listFiles(wt.lossy)} — move ${wt.lossy.length === 1 ? 'it' : 'them'}, or --with-ignored`);
      } else if (wt.lossy.length && wt.verdict !== 'failed') {
        warn(`${name} ${opts.apply ? 'lost' : 'would lose'} ignored ${listFiles(wt.lossy)}`);
      }
    }
    plain();
  }

  const count = (v) => rows.filter((r) => r.wt.verdict === v).length;
  const tally = ['merged', 'unused', 'removed', 'missing', 'cleared', 'dirty', 'ignored', 'nested', 'fresh', 'locked', 'unmerged', 'failed']
    .map((v) => [v, count(v)])
    .filter(([, n]) => n)
    .map(([v, n]) => `${n} ${v}`);
  plain(tally.join(c.dim(', ')));

  failed += count('failed');
  const done = opts.apply ? count('removed') + count('cleared') : count('merged') + count('unused') + count('missing');
  const freed = rows
    .filter((r) => (opts.apply ? r.wt.verdict === 'removed' : REMOVABLE.has(r.wt.verdict)))
    .reduce((n, r) => n + r.wt.size, 0);

  summary({ ok: done, okLabel: opts.apply ? 'removed' : 'to remove', skipped, failed });
  if (!done) return;
  if (opts.apply) {
    plain(`${c.green('freed')} ${c.bold(formatBytes(freed))} ${c.dim('— worktrees removed, branches kept')}`);
  } else {
    plain(`${c.dim('would free')} ${c.bold(formatBytes(freed))} ${c.dim('— run `talea prune --apply` to do it')}`);
  }
}
