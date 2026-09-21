// Target selection: turning `--group nonstopio --repo eklavya` into a repo list,
// and turning "what does this machine want" into one.
//
// Every command that acts on repos goes through here, so `clone`, `sync`,
// `status` and `exec` filter identically.

import { findWorkspace, loadManifest, loadState, repoDir, repoGroup } from './config.js';
import { isRepo } from './git.js';
import { fail } from './log.js';

const csv = (v) =>
  (Array.isArray(v) ? v : [v])
    .filter(Boolean)
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Resolve the workspace, manifest and state, or exit with a useful message.
 * Commands that need an initialised workspace call this first.
 */
export function requireWorkspace() {
  const root = findWorkspace();
  if (!root) {
    fail('Not inside a talea workspace (no .talea.json found).');
    console.error('\n  Run `talea init` to create one, or cd into an existing workspace.');
    process.exit(1);
  }
  const manifest = loadManifest(root);
  const state = loadState(root);
  return { root, manifest, state };
}

/**
 * The repos this machine has signed up for.
 *
 * `state.selected` is an explicit list, written by the picker on first sync or
 * by `talea add`. Until it exists, the catalogue's own `default: true` repos
 * stand in — that is what "a default set, already ticked" means on a machine
 * that has never been asked.
 *
 * A name in `selected` that the catalogue no longer has is ignored rather than
 * fatal: repos get renamed and deleted on GitHub, and a machine that has not
 * run `discover` since should still sync the other twenty.
 */
export function machineRepos(manifest, state) {
  const chosen = state.selected;
  if (!Array.isArray(chosen)) {
    return manifest.repos.filter((r) => r.default && !r.archived);
  }
  const wanted = new Set(chosen.map((n) => n.toLowerCase()));
  return manifest.repos.filter((r) => wanted.has(r.name.toLowerCase()));
}

/** Has this machine ever been asked what it wants? */
export const hasChosen = (state) => Array.isArray(state.selected);

/**
 * Filter a repo list by group / repo name.
 *
 * Unknown names are a hard error: silently doing nothing because of a typo is
 * the worst possible outcome for a bulk command.
 */
export function selectRepos(manifest, opts = {}, pool = manifest.repos) {
  const groups = csv(opts.group).map((g) => g.toLowerCase());
  const names = csv(opts.repo);

  const knownGroups = new Set(manifest.repos.map((r) => repoGroup(r).toLowerCase()));
  const unknownGroup = groups.find((g) => !knownGroups.has(g));
  if (unknownGroup) {
    fail(`Unknown group "${unknownGroup}".`);
    console.error(`\n  Known groups: ${[...knownGroups].join(', ')}`);
    process.exit(1);
  }

  const byName = new Set(manifest.repos.map((r) => r.name.toLowerCase()));
  const unknownRepo = names.find((n) => !byName.has(n.toLowerCase()));
  if (unknownRepo) {
    fail(`Unknown repo "${unknownRepo}".`);
    console.error('\n  Run `talea list` to see every repo in the catalogue.');
    process.exit(1);
  }

  // An explicit -r reaches past the machine's selection on purpose: naming a
  // repo is a request for that repo, not a request filtered by what was ticked
  // six months ago.
  let repos = names.length ? manifest.repos : pool;
  if (groups.length) repos = repos.filter((r) => groups.includes(repoGroup(r).toLowerCase()));
  if (names.length) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    repos = repos.filter((r) => wanted.has(r.name.toLowerCase()));
  }
  return repos;
}

/** Attach the on-disk path and cloned-ness to each repo. */
export function withPaths(manifest, root, repos) {
  return repos.map((repo) => {
    const dir = repoDir(manifest, root, repo);
    return { repo, dir, cloned: isRepo(dir) };
  });
}

/** Only the repos that actually exist on disk — sync/status/exec operate on these. */
export const clonedOnly = (entries) => entries.filter((e) => e.cloned);

/**
 * The catalogue is empty, so there is nothing any command can do. Say what to
 * run rather than printing a successful-looking run over zero repos.
 */
export function requireCatalogue(manifest) {
  if (manifest.repos.length) return;
  fail('The catalogue is empty.');
  console.error('\n  Run `talea discover` to build it from your GitHub account.');
  process.exit(1);
}
