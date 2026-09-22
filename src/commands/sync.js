import path from 'node:path';

import { defaultBranch, groupDir, repoGroup } from '../config.js';
import {
  aheadBehind,
  currentBranch,
  defaultJobs,
  fetch,
  ffMerge,
  hasUpstream,
  isDirty,
  isMissingRemote,
  pooled,
} from '../git.js';
import { board } from '../live.js';
import { c, context, glyph, heading, plain, summary, verdict, warn } from '../log.js';
import { chooseRepos } from '../select.js';
import { requireCatalogue, requireWorkspace, selectRepos, withPaths } from '../workspace.js';
import { adoptInPlace, cloneMissing, writeDocs } from './clone.js';

export const help = `
${c.bold('talea sync')} — make this machine match the list

  ${c.dim('talea sync')}                      clone what is missing, fast-forward the rest
  ${c.dim('talea sync --pick')}               change what this machine keeps, then sync
  ${c.dim('talea sync eklavya')}              only that repo (same as -r eklavya)
  ${c.dim('talea sync -g nonstopio')}         only that owner
  ${c.dim('talea sync --no-clone')}           fast-forward only, clone nothing

The first time you run this on a machine you are asked what it should keep:
your default set, or a checklist of everything in the catalogue with those
defaults already ticked. The answer is remembered in ${c.dim('.talea.json')}, so every run
after that is a bare ${c.dim('talea sync')}.

It runs from anywhere. Inside a workspace it uses that one; outside, it uses
the workspace ${c.dim('talea init')} made, or asks which when this machine has several.

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names; a bare name works too
      --pick            re-open the checklist before syncing
      --no-clone        do not clone anything new
      --no-adopt        do not look for checkouts to move into place
      --protocol <p>    ssh (default) or https
  -j, --jobs <n>        parallel operations (default: one per core, 6-12)

${c.bold('What it will not do')}

Fast-forwards only. A repo that has diverged is reported, never merged
automatically. A repo with uncommitted changes is fetched and left exactly as
you left it. A branch with no upstream is fetched and left alone.

It never switches branches. If you are on a feature branch, that is where you
are working, and a tool that moves you off it mid-task is no better than one
that clobbers your changes — so it fast-forwards the branch you are on, or
leaves it alone, and says which.
`;

export async function run(opts) {
  const { root, manifest, state } = await requireWorkspace();
  requireCatalogue(manifest);

  const protocol = opts.protocol ?? state.protocol ?? 'ssh';
  const jobs = Number(opts.jobs ?? defaultJobs());

  const { repos: chosen } = await chooseRepos({ manifest, root, state, opts });
  const repos = selectRepos(manifest, opts, chosen);

  if (!repos.length) {
    warn('Nothing selected for this machine. Run `talea sync --pick` to choose.');
    return;
  }

  // Adopt before cloning, never after: a repo already on disk must be moved
  // into place, not cloned a second time beside the work in it.
  const adoption =
    opts.adopt === false || opts.clone === false
      ? { skip: new Map() }
      : await adoptInPlace({ manifest, root, state, repos, opts });

  // Before the network work, not after: the group doc explains what is about to
  // land in the folder, and it must also appear on a re-run where nothing is
  // cloned at all — that is how an existing workspace picks up a new template.
  writeDocs(manifest, root, repos);

  const entries = withPaths(manifest, root, repos);
  const missing = entries.filter((e) => !e.cloned && !adoption.skip.has(e.repo.name));
  const present = entries.filter((e) => e.cloned);

  heading(`Syncing ${root}`);
  context([
    ['repos', `${entries.length}`],
    ['to clone', `${opts.clone === false ? 0 : missing.length}`],
    ['on disk', `${present.length}`],
    ['jobs', `${jobs}`],
  ]);

  const counts = { ok: 0, skipped: adoption.skip.size, failed: 0, okLabel: 'synced' };

  if (missing.length && opts.clone !== false) {
    plain('');
    const cloneCounts = { ok: 0, skipped: 0, failed: 0, okLabel: 'cloned' };
    await cloneMissing({ manifest, root, entries: missing, protocol, jobs, counts: cloneCounts });
    counts.ok += cloneCounts.ok;
    counts.skipped += cloneCounts.skipped;
    counts.failed += cloneCounts.failed;
  } else if (missing.length) {
    counts.skipped += missing.length;
  }

  if (present.length) {
    plain('');
    await fastForward({ manifest, root, entries: present, jobs, counts });
  }

  summary(counts);
  verdict(counts, {
    clear: 'ALL CLEAR · every repo is on disk and level with origin',
    partial: `${counts.skipped} repo(s) were fetched only or left alone — see above`,
    trouble: `${counts.failed} repo(s) need attention — review above`,
  });
}

/**
 * Fetch each repo once, then fast-forward the branch it is on.
 *
 * One fetch, not two: `git pull` fetches again on top of the fetch we already
 * did, and `ffMerge` merges the ref that fetch just updated. Over twenty repos
 * on a slow link that is half the wall clock.
 */
async function fastForward({ manifest, root, entries, jobs, counts }) {
  const view = board(
    entries.map(({ repo }) => ({
      id: repo.name,
      group: groupDir(manifest, repoGroup(repo)),
      label: repo.name,
    })),
  );

  await pooled(entries, jobs, async ({ repo, dir }) => {
    view.set(repo.name, 'busy', 'fetching …');
    const fetched = await fetch(dir);

    if (fetched.code !== 0) {
      // A repo the catalogue lists but this account cannot reach is not a
      // broken checkout — nothing here or in a retry fixes it, so say so and
      // let the rest of the run stand.
      if (isMissingRemote(fetched.stderr)) {
        counts.skipped++;
        view.set(repo.name, 'skip', 'origin is gone or not granted to you, left as it is');
        return;
      }
      counts.failed++;
      view.set(repo.name, 'fail', 'fetch failed');
      view.note(repo.name, fetched.stderr.split('\n')[0] ?? 'fetch failed');
      return;
    }

    // Independent reads of the same checkout — no reason to wait for one before
    // starting the other, and every repo pays for all three.
    const [branch, dirty, tracked] = await Promise.all([
      currentBranch(dir),
      isDirty(dir),
      hasUpstream(dir),
    ]);

    // `currentBranch` is `rev-parse --abbrev-ref HEAD`, which reports the
    // literal string "HEAD" when nothing is checked out. Printing that as if it
    // were a branch name is how "HEAD tracks no remote branch" happens.
    const where = branch === 'HEAD' ? 'a detached HEAD' : branch;
    const home = defaultBranch(repo);
    const away = home && branch !== home && branch !== 'HEAD' ? c.dim(` (not ${home})`) : '';

    if (dirty) {
      counts.skipped++;
      view.set(repo.name, 'warn', `uncommitted changes on ${where}, fetched only`);
      return;
    }

    if (!tracked) {
      // A local-only branch has nothing to fast-forward onto. Saying so beats
      // the "no upstream configured" git spits out of a bare merge.
      counts.skipped++;
      view.set(repo.name, 'skip', `${where} tracks no remote branch, fetched only`);
      return;
    }

    const res = await ffMerge(dir);
    if (res.code !== 0) {
      counts.failed++;
      const reason = /diverge|non-fast-forward|not possible to fast-forward/i.test(res.stderr)
        ? 'diverged from origin — needs a manual merge or rebase'
        : (res.stderr.split('\n')[0] ?? 'fast-forward failed');
      view.set(repo.name, 'fail', `${branch} — ${reason}`);
      return;
    }

    counts.ok++;
    const delta = await aheadBehind(dir);
    const note = res.stdout.includes('Already up to date') ? c.dim('up to date') : c.green('updated');
    const ahead = delta?.ahead ? c.yellow(` ${glyph.up}${delta.ahead}`) : '';
    view.set(repo.name, 'ok', `${c.cyan(branch)}${away} ${note}${ahead}`);
  });

  view.stop();
  return counts;
}
