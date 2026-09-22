import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { defaultBranch, groupDir, repoGroup, repoUrl, saveState } from '../config.js';
import { dropDocs } from '../docs.js';
import { clone, defaultJobs, isMissingRemote, pooled } from '../git.js';
import { board } from '../live.js';
import { c, heading, icon, ok, plain, summary, warn } from '../log.js';
import { chooseRepos } from '../select.js';
import { adoptable, requireCatalogue, requireWorkspace, selectRepos, withPaths } from '../workspace.js';
import { applyMoves, parseFromPaths, planFor } from './adopt.js';

export const help = `
${c.bold('talea clone')} — clone what is missing, and nothing else

  ${c.dim('talea clone')}                     clone every repo this machine keeps
  ${c.dim('talea clone -g nonstopio')}        only that owner
  ${c.dim('talea clone -r eklavya')}          a single repo, whether or not it is selected
  ${c.dim('talea clone --pick')}              re-open the checklist first

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names
      --pick            choose what this machine keeps before cloning
      --protocol <p>    ssh (default) or https
      --from <path>     also search here for existing checkouts (repeatable)
      --no-adopt        skip the existing-checkout check and only clone
  -j, --jobs <n>        parallel clones (default: one per core, 6-12)

Before cloning anything, the workspace is checked for repos that are already on
disk in the wrong place — cloned by hand, or moved by a catalogue change. Those
are ${c.bold('moved')} into place, keeping every branch and uncommitted change, instead of
being cloned again. Pass ${c.dim('--from ~/Desktop')} to look outside the workspace too;
folders you name are remembered.

Already-cloned repos are left completely alone, so re-running is safe. A repo
the server will not hand over — renamed, deleted, or never granted to your
account — is reported and skipped, not failed.

${c.dim('talea sync')} does this and then fast-forwards. This command is the half you want
when you are on a slow connection and do not care about merging yet.
`;

/**
 * Relocate checkouts that are already on disk but in the wrong place.
 *
 * The workspace itself is always searched — that is how a catalogue change that
 * moves a repo between groups reaches everyone who already cloned it. Anywhere
 * else is only searched when it has been named explicitly, because moving
 * repositories found by guesswork is not ours to do.
 *
 * Returns the repos to keep OUT of the clone set. Anything left where it is
 * must not be cloned as well, or a fresh copy lands beside the developer's
 * existing checkout — the one outcome this whole module exists to prevent.
 */
export async function adoptInPlace({ manifest, root, state, repos, opts }) {
  const extra = parseFromPaths(opts.from);
  const scanRoots = [...new Set([root, ...(state.scanPaths ?? []), ...extra])];

  // Remembered before anything moves. `applyMoves` appends to the same state
  // file, so writing this afterwards from a stale snapshot would wipe the
  // `adopted` move log — the exact record `talea adopt --fix-paths` replays.
  if (extra.length) {
    saveState(root, { ...state, scanPaths: [...new Set([...(state.scanPaths ?? []), ...extra])] });
  }

  const ours = repos.filter((r) => !r.ignore);
  const { moves, parks, refused } = await planFor({
    manifest,
    root,
    repos: ours,
    scanRoots,
    jobs: opts.jobs,
  });

  // A name-only match means the remote host is not one the catalogue lists, so
  // it is probably right but not certainly. This runs unattended, so it only
  // relocates certain matches; the rest are named and left for `talea adopt`,
  // where they are shown before anything moves.
  const certain = moves.filter((m) => m.confidence === 'exact');
  const unsure = moves.filter((m) => m.confidence !== 'exact');

  const skip = new Map();
  for (const m of unsure) skip.set(m.repo.name, 'its remote host is not one the catalogue lists');
  for (const r of refused) skip.set(r.repo.name, r.reason);

  if (certain.length || parks.length) {
    const bits = [];
    if (certain.length) bits.push(`${certain.length} to move into place`);
    if (parks.length) bits.push(`${parks.length} second cop${parks.length === 1 ? 'y' : 'ies'} to park`);
    heading(`Existing checkouts: ${bits.join(', ')}`);

    const applied = await applyMoves(root, certain, parks, manifest);
    for (const r of applied.results.filter((x) => !x.ok)) skip.set(r.plan.repo.name, 'its move failed');
  }

  if (skip.size) {
    plain('');
    for (const [name, reason] of skip) warn(`${c.bold(name)} left alone — ${reason}`);
    plain(c.dim('  Not cloned either, so nothing lands beside it. Run `talea adopt` to sort it out.'));
  }

  return { skip };
}

/**
 * Clone the entries that are not on disk. Shared with `sync`, which clones the
 * missing before fast-forwarding the rest — one command for "make this machine
 * match the list".
 *
 * Mutates and returns `counts` so a caller can fold cloning and syncing into a
 * single summary.
 */
export async function cloneMissing({ manifest, root, entries, protocol, jobs, counts }) {
  const view = board(
    entries.map(({ repo }) => ({
      id: repo.name,
      group: groupDir(manifest, repoGroup(repo)),
      label: repo.name,
    })),
  );

  await pooled(entries, jobs, async ({ repo, dir }) => {
    const url = repoUrl(manifest, repo, protocol);
    const branch = defaultBranch(repo);
    view.set(repo.name, 'busy', branch ? `cloning ${branch} …` : 'cloning …');

    // Anything already sitting at the destination belongs to the developer, not
    // to us. A folder with no .git could be hand-made notes, a half-finished
    // checkout, or a repo whose .git was moved — none of which we may delete.
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      counts.skipped++;
      view.set(
        repo.name,
        'warn',
        `${path.relative(root, dir)} already exists and is not a git repo, leaving it untouched`,
      );
      return;
    }

    mkdirSync(path.dirname(dir), { recursive: true });
    const res = await clone(url, dir, branch ?? undefined);

    // Only retry on the specific failure this fallback is for: the catalogue
    // naming a branch the remote no longer has, which happens whenever a repo
    // is renamed from master to main after the last discover. Any other failure
    // (auth, network, disk) must be reported as itself.
    const branchMissing =
      branch && /remote branch .* not found|could not find remote branch/i.test(res.stderr);

    if (res.code !== 0 && branchMissing) {
      // Safe to clear: we got here having confirmed the path was empty, so the
      // only thing here is the partial directory this failed clone just made.
      rmSync(dir, { recursive: true, force: true });
      const retry = await clone(url, dir, undefined);
      if (retry.code === 0) {
        counts.ok++;
        view.set(repo.name, 'skip', `cloned on the default branch (no ${branch} on origin)`);
        return;
      }
      counts.failed++;
      view.set(repo.name, 'fail', 'clone failed');
      view.note(repo.name, retry.stderr.split('\n')[0] ?? 'clone failed');
      return;
    }

    if (res.code !== 0 && isMissingRemote(res.stderr)) {
      // The catalogue lists it, the server does not hand it over. Not a broken
      // workspace and not something a retry mends — skip it, clone the rest.
      counts.skipped++;
      view.set(repo.name, 'skip', 'origin is gone or not granted to you, not cloned');
      return;
    }

    if (res.code !== 0) {
      counts.failed++;
      view.set(repo.name, 'fail', 'clone failed');
      view.note(repo.name, res.stderr.split('\n')[0] ?? 'clone failed');
      return;
    }

    counts.ok++;
    view.set(
      repo.name,
      'ok',
      `${icon.arrow} ${branch ? c.cyan(branch) : c.dim('default')} ${c.dim(path.relative(root, dir))}`,
    );
  });

  view.stop();
  return counts;
}

/** Group docs, for the folders repos live in. Shared by `clone` and `sync`. */
export function writeDocs(manifest, root, repos) {
  const docs = dropDocs(manifest, root, new Set(repos.map((r) => repoGroup(r))));
  if (!docs.written.length) return;
  heading('Workspace docs');
  for (const file of docs.written) ok(`CLAUDE.md ${c.dim(`→ ${path.relative(root, file)}`)}`);
}

export async function run(opts) {
  const { root, manifest, state } = await requireWorkspace();
  requireCatalogue(manifest);

  const protocol = opts.protocol ?? state.protocol ?? 'ssh';
  const jobs = opts.jobs ?? defaultJobs();

  const { repos: chosen } = await chooseRepos({ manifest, root, state, opts });
  const repos = selectRepos(manifest, opts, chosen);

  const adoption =
    opts.adopt === false
      ? { skip: new Map() }
      : await adoptInPlace({ manifest, root, state, repos, opts });

  writeDocs(manifest, root, repos);

  const entries = withPaths(manifest, root, repos);
  const todo = entries.filter((e) => !e.cloned && !adoption.skip.has(e.repo.name));
  const already = entries.filter((e) => e.cloned).length;

  heading(`Cloning into ${root}`);
  // A repo left alone counts against the run: without this, a clone that
  // quietly skipped a stranded repo would still exit 0.
  const counts = { ok: 0, skipped: already, failed: adoption.skip.size, okLabel: 'cloned' };

  if (!todo.length) {
    summary(counts);
    return;
  }

  plain('');
  await cloneMissing({ manifest, root, entries: todo, protocol, jobs, counts });
  summary(counts);

  if (counts.failed) {
    plain(c.dim('\nFailed clones are usually SSH access. Run `talea doctor` to check.'));
  }
}
