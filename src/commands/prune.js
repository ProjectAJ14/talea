// Removing worktrees whose work is already on origin.
//
// The only command that deletes anything, so the rules are narrow and every
// one of them is git's rather than ours: the removal is `git worktree remove`
// without --force, which refuses a tree with modified or untracked files by
// itself; a worktree is only offered when every commit on it is already on
// origin's default branch; and nothing happens without --apply. The branch is
// never deleted — it costs nothing, and `git worktree add` brings the checkout
// back. What a removal really frees is node_modules, build and .dart_tool.

import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { worktreeRecords, lines } from '../adopt.js';
import { defaultBranch, groupDir, repoGroup } from '../config.js';
import { defaultJobs, fetch, git, isDirty, pooled } from '../git.js';
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
  nested     merged, but another worktree or repo is inside ${c.dim('→ kept')}
  fresh      a branch with no commits of its own yet      ${c.dim('→ kept')}
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
add --with-ignored to remove them along with the folder.

A ${c.bold('fresh')} worktree is one whose branch has never moved since it was created:
no commits yet, so it looks merged, but it is a task just started.

A repo with no default branch recorded is skipped: run \`talea discover\`.

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names; a bare name works too
      --all             ignore this machine's selection
      --apply           actually remove; without it nothing changes
      --with-ignored    also remove merged worktrees holding ignored files
`;

// Ignored paths that a build or an install puts back. Anything ignored and NOT
// under one of these is somebody's file, and the plan names it before removal.
const REGENERABLE = new Set([
  'node_modules', 'build', 'dist', '.dart_tool', '.next', '.nuxt', '.turbo',
  '.astro', '.cache', 'target', '.venv', 'venv', 'Pods', 'coverage', '.gradle',
  '__pycache__', '.pytest_cache', '.DS_Store', '.firebase',
]);
// Seeded by worktree tooling as a copy of the main checkout's.
const REGENERABLE_FILES = new Set(['.claude/settings.local.json']);

/** Ignored entries (from `ls-files --directory`) that are not build output. */
export function lossyIgnored(listing) {
  return lines(listing).filter((p) => {
    const clean = p.replace(/\/$/, '');
    return !REGENERABLE_FILES.has(clean) && !clean.split('/').some((s) => REGENERABLE.has(s));
  });
}

/**
 * Bytes on disk under `root`, symlinks not followed, and every folder below
 * the root that has a `.git` of its own — another worktree or checkout.
 *
 * The second half is a safety check, not a statistic. git reads a worktree as
 * clean when the only thing in it is a nested worktree under an ignored path
 * (`.claude/worktrees/x`), and `git worktree remove` then deletes the nested
 * one with its uncommitted work. So a worktree with any repo inside it is kept.
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

/** One worktree's verdict. The order matters: a locked record is never touched. */
async function judge(repoDir, wt, base) {
  if (wt.locked) return 'locked';
  if (wt.prunable || !existsSync(wt.path)) return 'missing';
  if (await isDirty(wt.path)) return 'dirty';
  if (!wt.head) return 'unmerged';
  if (!(await isMerged(repoDir, wt.head, base))) return 'unmerged';
  // A branch cut a minute ago has no commits of its own, so it is trivially
  // "merged" — but it is a task just started, not one finished. Its reflog
  // still holds only the creation entry; any commit, reset or pull adds one.
  if (wt.branch) {
    const log = await git(['reflog', 'show', '--format=%H', `refs/heads/${wt.branch}`], { cwd: repoDir });
    if (log.code === 0 && lines(log.stdout).length === 1) return 'fresh';
  }
  return 'merged';
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
 * `{ base, worktrees: [{ path, branch, verdict, size, lossy }] }`.
 * `withIgnored` lets a merged worktree go even with lossy ignored files in it.
 */
export async function planRepo({ repo, dir }, { withIgnored = false } = {}) {
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
    let verdict = await judge(dir, wt, base);
    const { size, nested } = verdict === 'missing' ? { size: 0, nested: [] } : await measure(wt.path);
    if (verdict === 'merged' && nested.length) verdict = 'nested';
    let lossy = [];
    if (verdict === 'merged') {
      const ignored = await git(
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
        { cwd: wt.path },
      );
      lossy = lossyIgnored(ignored.stdout);
      // git deletes ignored files without asking, and `--apply` plans and
      // removes in one run — so a warning here would arrive after the loss.
      if (lossy.length && !withIgnored) verdict = 'ignored';
    }
    worktrees.push({ path: wt.path, branch: wt.branch, verdict, size, lossy });
  }
  return { base, worktrees };
}

/**
 * Carry out one repo's plan. Mutates each worktree's `verdict` to what
 * happened — `removed`, `cleared`, or `failed` with an `error`.
 */
export async function applyRepo(dir, plan) {
  for (const wt of plan.worktrees) {
    if (wt.verdict !== 'merged') continue;
    // Never --force: git refusing is the last guard on uncommitted work.
    const res = await git(['worktree', 'remove', wt.path], { cwd: dir });
    if (res.code === 0) wt.verdict = 'removed';
    else Object.assign(wt, { verdict: 'failed', error: res.stderr || 'git refused' });
  }
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

  const plans = await pooled(entries, opts.jobs ?? defaultJobs(), async (entry) => {
    const plan = await planRepo(entry, { withIgnored: opts['with-ignored'] });
    if (opts.apply && plan.worktrees) await applyRepo(entry.dir, plan);
    return { ...entry, plan };
  });

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
    table(
      groupRows.map(({ repo, wt }) => [
        '  ' + c.bold(repo.name),
        tilde(wt.path),
        wt.branch ?? c.dim('(detached)'),
        PAINT[wt.verdict](wt.verdict),
        wt.size ? formatBytes(wt.size) : c.dim('—'),
      ]),
      ['  REPO', 'WORKTREE', 'BRANCH', 'VERDICT', 'SIZE'],
    );
    for (const { wt } of groupRows) {
      if (wt.error) fail(`${tilde(wt.path)} — ${wt.error}`);
      if (wt.verdict === 'ignored') {
        warn(`${tilde(wt.path)} kept for ignored files: ${wt.lossy.join(', ')} — move them, or --with-ignored`);
      } else if (wt.lossy.length && wt.verdict !== 'failed') {
        warn(`${tilde(wt.path)} ${opts.apply ? 'lost' : 'would lose'} ignored files: ${wt.lossy.join(', ')}`);
      }
    }
    plain();
  }

  const count = (v) => rows.filter((r) => r.wt.verdict === v).length;
  const tally = ['merged', 'removed', 'missing', 'cleared', 'dirty', 'ignored', 'nested', 'fresh', 'locked', 'unmerged', 'failed']
    .map((v) => [v, count(v)])
    .filter(([, n]) => n)
    .map(([v, n]) => `${n} ${v}`);
  plain(tally.join(c.dim(', ')));

  failed += count('failed');
  const done = opts.apply ? count('removed') + count('cleared') : count('merged') + count('missing');
  const freed = rows
    .filter((r) => r.wt.verdict === (opts.apply ? 'removed' : 'merged'))
    .reduce((n, r) => n + r.wt.size, 0);

  summary({ ok: done, okLabel: opts.apply ? 'removed' : 'to remove', skipped, failed });
  if (!done) return;
  if (opts.apply) {
    plain(`${c.green('freed')} ${c.bold(formatBytes(freed))} ${c.dim('— worktrees removed, branches kept')}`);
  } else {
    plain(`${c.dim('would free')} ${c.bold(formatBytes(freed))} ${c.dim('— run `talea prune --apply` to do it')}`);
  }
}
