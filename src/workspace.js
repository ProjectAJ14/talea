// Target selection: turning `--group nonstopio --repo eklavya` into a repo list,
// and turning "what does this machine want" into one.
//
// Every command that acts on repos goes through here, so `clone`, `sync`,
// `status` and `exec` filter identically.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

import { samePath } from './adopt.js';
import {
  STATE_FILE,
  findWorkspace,
  knownWorkspaces,
  loadManifest,
  loadState,
  readUserState,
  repoDir,
  repoGroup,
  writeUserState,
} from './config.js';
import { isRepo } from './git.js';
import { c, fail } from './log.js';

const csv = (v) =>
  (Array.isArray(v) ? v : [v])
    .filter(Boolean)
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Add a workspace to this machine's list, once.
 *
 * Compared with samePath, not as strings: on macOS and Windows `~/workspace`
 * and `~/Workspace` are one folder, and cd-ing in with the other spelling would
 * otherwise add it again on every run.
 */
export function rememberWorkspace(root) {
  const state = readUserState();
  const list = state.workspaces ?? [];
  if (list.some((dir) => samePath(dir, root))) return;
  writeUserState({ ...state, workspaces: [...list, root] });
}

/**
 * The workspaces a command run from outside any of them could mean: every one
 * `init` has recorded, plus the default `~/Workspace` — which is how a
 * workspace made before the list existed is still found from anywhere.
 */
export function workspaceCandidates(known = knownWorkspaces(), manifest = loadManifest(null)) {
  const fallback = path.join(os.homedir(), manifest.workspace || 'Workspace');
  const all = existsSync(path.join(fallback, STATE_FILE)) ? [...known, fallback] : known;
  return all.filter((dir, i) => all.findIndex((d) => samePath(d, dir)) === i);
}

/**
 * Outside a workspace: one known workspace is used, several are asked about.
 *
 * Everything here goes to stderr — `cd $(talea where)` reads stdout, and a
 * prompt or a note there is a folder the shell tries to enter. With no
 * terminal to ask on, it stops rather than picks: a script that syncs whichever
 * workspace happened to be first is running against a tree nobody named.
 */
async function pickKnownWorkspace() {
  const found = workspaceCandidates();

  if (!found.length) {
    fail('Not inside a talea workspace (no .talea.json found).');
    console.error('\n  Run `talea init` to create one, or cd into an existing workspace.');
    process.exit(1);
  }
  if (found.length === 1) {
    console.error(c.dim(`Using the workspace at ${found[0]}\n`));
    return found[0];
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail(`Not inside a talea workspace, and this machine has ${found.length}.`);
    for (const dir of found) console.error(`    ${c.bold(dir)}`);
    console.error('\n  cd into the one you mean.');
    process.exit(1);
  }

  console.error(`\n${c.bold('Which workspace?')}`);
  found.forEach((dir, i) => console.error(`  ${c.cyan(String(i + 1))}  ${dir}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`\n${c.dim(`[1-${found.length}]`)} `)).trim();
  rl.close();

  // A wrong answer stops, same as a typo'd repo name: guessing here would run
  // a bulk command against a tree the developer did not choose.
  const chosen = found[Number(answer) - 1];
  if (!/^\d+$/.test(answer) || !chosen) {
    fail(`"${answer}" is not one of 1-${found.length}.`);
    process.exit(1);
  }
  console.error('');
  return chosen;
}

/**
 * Resolve the workspace, manifest and state, or exit with a useful message.
 * Commands that need an initialised workspace call this first.
 *
 * Inside a workspace the upward walk wins, exactly as git's does. Outside one,
 * the workspaces this machine knows about are offered instead.
 */
export async function requireWorkspace() {
  const inside = findWorkspace();
  // Recorded on every run from inside, so a workspace made before the list
  // existed joins it the first time anything is run there.
  if (inside) rememberWorkspace(inside);
  const root = inside ?? (await pickKnownWorkspace());
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
    return manifest.repos.filter((r) => r.default && !r.archived && !r.ignore);
  }
  const wanted = new Set(chosen.map((n) => n.toLowerCase()));
  return manifest.repos.filter((r) => wanted.has(r.name.toLowerCase()) && !r.ignore);
}

/**
 * Repos talea is allowed to touch at all.
 *
 * `ignore: true` means something else owns that checkout — another workspace
 * manager, a vendored tree, an SDK cache. Without it two tools that both
 * organise repositories will each drag the same checkout back to where it
 * thinks it belongs, on every run, forever. Found with a repo living inside a
 * second workspace manager's tree on the same disk.
 *
 * This is stronger than not selecting it: `adopt` deliberately works over the
 * whole catalogue rather than this machine's selection, because a stray
 * checkout is worth moving whether or not the machine signed up for it. An
 * ignored repo is out of even that.
 */
export const adoptable = (manifest) => manifest.repos.filter((r) => !r.ignore);

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
