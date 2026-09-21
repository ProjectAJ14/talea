// "What does this machine keep?" — asked once, remembered forever.
//
// The answer lives in `.talea.json` as a list of repo names. Until it exists,
// the catalogue's `default: true` repos stand in, and the first interactive
// `sync` or `init` offers the picker with exactly those ticked.
//
// Why a list of names rather than a filter: a filter re-evaluates. Adding
// `default: true` to a repo in the catalogue would silently start cloning it on
// every machine you own, which is not a decision the catalogue gets to make.

import { saveState } from './config.js';
import { c, fail, plain, warn } from './log.js';
import { askScope, buildTree, pickByLine, pickRepos, selectedRepos } from './prompt.js';
import { hasChosen, machineRepos } from './workspace.js';

/**
 * Show the checklist and return what was ticked, or null if cancelled.
 *
 * The full-screen list needs raw mode. `setRawMode` always *exists* on a TTY
 * stream, so the failure to plan for is it THROWING — some Windows console
 * hosts raise ERR_TTY_INIT_FAILED. Fall back to typing names rather than
 * letting that escape and taking a default nobody chose.
 */
export async function runPicker(rows, title) {
  try {
    return await pickRepos(rows, { title });
  } catch (err) {
    warn(`This terminal could not enter raw mode (${err.code ?? err.message}).`);
    const { picked, unknown } = await pickByLine(rows);
    if (unknown.length) {
      fail(`Unknown name${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
      process.exit(1);
    }
    return picked;
  }
}

const interactive = () => process.stdin.isTTY && process.stdout.isTTY;

/**
 * The repos this run is about, asking the machine's owner if nobody has.
 *
 * `--pick` re-opens the checklist with the current selection ticked, which is
 * how you change your mind without editing JSON.
 *
 * An explicit -g/-r never prompts, so scripts and CI behave the same on a fresh
 * machine as on an old one.
 */
export async function chooseRepos({ manifest, root, state, opts = {} }) {
  const already = machineRepos(manifest, state);

  if (opts.group || opts.repo) return { repos: already, asked: false };

  const mustAsk = opts.pick || !hasChosen(state);
  if (!mustAsk) return { repos: already, asked: false };

  if (!interactive()) {
    // Nobody to ask. The defaults are a sane answer and saying which one was
    // taken is better than silently picking it.
    if (!hasChosen(state)) {
      plain(c.dim(`  Not a terminal — taking the catalogue's default set (${already.length} repos).`));
    }
    return { repos: already, asked: false };
  }

  const groups = new Set(manifest.repos.map((r) => r.group ?? r.owner ?? 'repos'));
  const chosenNames = new Set(already.map((r) => r.name));

  if (!opts.pick) {
    const scope = await askScope({
      defaults: already.length,
      total: manifest.repos.length,
      groups: groups.size,
    });
    if (scope === 'defaults') {
      saveState(root, { ...state, selected: already.map((r) => r.name) });
      return { repos: already, asked: true };
    }
  }

  // Everything is listed, including the archived and the forks. The point of
  // the checklist is that this machine can take something the default set does
  // not have — a repo you only touch on the desktop should not need a catalogue
  // edit to reach.
  const rows = buildTree(manifest, manifest.repos, (repo) => chosenNames.has(repo.name));
  const picked = await runPicker(rows, 'What should this machine keep?');

  if (picked === null) {
    plain(c.dim('\nCancelled — nothing changed.'));
    process.exit(0);
  }

  saveState(root, { ...state, selected: picked.map((r) => r.name) });
  return { repos: picked, asked: true };
}

export { selectedRepos };
