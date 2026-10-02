// `talea add` / `talea rm` — change what this machine keeps, one repo at a time.
//
// One file for both because they are one operation with a sign. `rm` never
// deletes a checkout: it takes the repo off this machine's list and says where
// the folder still is, because removing a directory full of somebody's work is
// not a thing a CLI should do on the back of a three-letter command.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { repoDir, repoId, repoLabel, requireOwnFolders, saveState } from '../config.js';
import { defaultJobs } from '../git.js';
import { c, fail, heading, info, ok, plain, skip } from '../log.js';
import { lookup, requireCatalogue, requireWorkspace, selectionIds, withPaths } from '../workspace.js';
import { adoptInPlace, cloneMissing, writeDocs } from './clone.js';

export const help = `
${c.bold('talea add')} — keep another repo on this machine

  ${c.dim('talea add eklavya')}               add it to the list and clone it now
  ${c.dim('talea add nonstopio/json-viewer')} when two owners have the same repo name
  ${c.dim('talea rm eklavya')}                take it off the list — the folder stays

${c.dim('add')} is the escape hatch from the checklist: one repo you want on this machine
without re-opening the picker or editing JSON. It writes to ${c.dim('.talea.json')}, which
is this machine's file, so it never changes what any other machine keeps.

${c.dim('rm')} removes the repo from the list and stops there. The checkout is left
exactly where it is and the path is printed — deleting it is your call, and
${c.dim('rm -rf')} already exists for when you mean it.

The list is written as ${c.dim('owner/name')}, so keeping one owner's repo never keeps
another's of the same name. A repo marked ${c.dim('ignore: true')} is refused: another tool
owns that checkout.

Options
      --protocol <p>    ssh (default) or https
  -j, --jobs <n>        parallel clones
`;

export { lookup };

/** Resolve `name` or `owner/name` against the catalogue, or exit saying why. */
export function resolve(manifest, name) {
  const matches = lookup(manifest, name);

  if (!matches.length) {
    fail(`No repo called "${name}" in the catalogue.`);
    console.error('\n  Run `talea discover --apply` if it is new, or `talea list` to see what is there.');
    process.exit(1);
  }
  if (matches.length > 1) {
    fail(`"${name}" is ambiguous — name the owner too: ${matches.map((r) => repoLabel(manifest, r)).join(', ')}`);
    process.exit(1);
  }
  return matches[0];
}

export async function run(opts, positionals = []) {
  const { root, manifest, state } = await requireWorkspace();
  requireCatalogue(manifest);

  if (!positionals.length) {
    fail(`Nothing named. ${opts.removing ? 'talea rm <repo>' : 'talea add <repo>'}`);
    process.exit(1);
  }

  // `rm app` where two owners share it: the bare entry an older list holds
  // cannot be resolved, but it can be dropped as written — the one way to
  // answer "neither" to the warning it prints.
  const legacy = (n) =>
    opts.removing && lookup(manifest, n).length > 1 && (state.selected ?? []).some((e) => e.toLowerCase() === n.toLowerCase());
  const dropped = positionals.filter(legacy);
  const targets = positionals.filter((n) => !legacy(n)).map((n) => resolve(manifest, n));
  const label = (repo) => repoLabel(manifest, repo);

  // The current list as ids, made explicit. Until now this machine may have
  // been running on the catalogue's defaults; the moment it adds or removes
  // one it has an opinion, and that opinion has to be written down or the next
  // sync would silently undo it. Entries this cannot pin to one repo stay as
  // written (see selectionIds), so removing alice/app never touches bob/app.
  let list = selectionIds(manifest, state);

  if (opts.removing) {
    heading('Removing from this machine');
    for (const n of dropped) {
      list = list.filter((e) => e.toLowerCase() !== n.toLowerCase());
      ok(`${c.bold(n)} ${c.dim('off the list — it named no one repo')}`);
    }
    for (const repo of targets) {
      if (!list.includes(repoId(repo))) {
        skip(`${c.bold(label(repo))} was not on this machine's list`);
        continue;
      }
      list = list.filter((id) => id !== repoId(repo));
      const dir = repoDir(manifest, root, repo);
      ok(`${c.bold(label(repo))} ${c.dim('off the list')}`);
      if (existsSync(dir)) {
        plain(`    ${c.dim(`the checkout is still at ${path.relative(root, dir)} — delete it yourself if you want it gone`)}`);
      }
    }
    saveState(root, { ...state, selected: list });
    return;
  }

  // Rule 4: another tool owns an ignored repo's checkout. Keeping it here would
  // clone it now and fight that tool on every sync after.
  const owned = targets.filter((r) => r.ignore);
  if (owned.length) {
    for (const r of owned) fail(`${label(r)} is marked ignore: true — another tool owns that checkout, so talea will not keep it.`);
    process.exit(1);
  }

  requireOwnFolders(manifest, targets);
  heading('Adding to this machine');
  const added = [];
  for (const repo of targets) {
    if (list.includes(repoId(repo))) {
      skip(`${c.bold(label(repo))} is already on this machine's list`);
      continue;
    }
    // Naming one owner answers what a bare legacy entry two owners share could
    // not, so that entry goes; any other entry stays as written.
    const stale = (entry) => entry.toLowerCase() === repo.name.toLowerCase() && lookup(manifest, entry).length > 1;
    list = [...list.filter((entry) => !stale(entry)), repoId(repo)];
    added.push(repo);
    ok(`${c.bold(label(repo))} ${c.dim(`→ ${path.relative(root, repoDir(manifest, root, repo))}`)}`);
  }

  saveState(root, { ...state, selected: list });
  if (!added.length) return;

  // Adopt first, in case the repo being added is one already sitting somewhere
  // else on this disk — that is the common case for `add`, not the rare one.
  const adoption = await adoptInPlace({
    manifest,
    root,
    state: { ...state, selected: list },
    repos: added,
    opts,
  });

  // A worktree the move left unlinked is reported with its fix; it fails the run.
  if (adoption.broken) process.exitCode = 1;
  writeDocs(manifest, root, added);

  const todo = withPaths(manifest, root, added).filter(
    (e) => !e.cloned && !adoption.skip.has(repoId(e.repo)),
  );
  if (!todo.length) {
    info('Nothing to clone — already on disk.');
    return;
  }

  plain('');
  const counts = { ok: 0, skipped: 0, failed: 0, okLabel: 'cloned' };
  await cloneMissing({
    manifest,
    root,
    entries: todo,
    protocol: opts.protocol ?? state.protocol ?? 'ssh',
    jobs: opts.jobs ?? defaultJobs(),
    counts,
  });
  if (counts.failed) process.exitCode = 1;
}
