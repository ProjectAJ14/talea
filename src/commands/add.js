// `talea add` / `talea rm` — change what this machine keeps, one repo at a time.
//
// One file for both because they are one operation with a sign. `rm` never
// deletes a checkout: it takes the repo off this machine's list and says where
// the folder still is, because removing a directory full of somebody's work is
// not a thing a CLI should do on the back of a three-letter command.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { repoDir, saveState } from '../config.js';
import { defaultJobs } from '../git.js';
import { c, fail, heading, info, ok, plain, skip } from '../log.js';
import { machineRepos, requireCatalogue, requireWorkspace, withPaths } from '../workspace.js';
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

Options
      --protocol <p>    ssh (default) or https
  -j, --jobs <n>        parallel clones
`;

/** Resolve `name` or `owner/name` against the catalogue, or exit saying why. */
export function resolve(manifest, name) {
  const wanted = String(name).toLowerCase();
  const matches = manifest.repos.filter(
    (r) => r.name.toLowerCase() === wanted || `${r.owner}/${r.name}`.toLowerCase() === wanted,
  );

  if (!matches.length) {
    fail(`No repo called "${name}" in the catalogue.`);
    console.error('\n  Run `talea discover --apply` if it is new, or `talea list` to see what is there.');
    process.exit(1);
  }
  if (matches.length > 1) {
    fail(`"${name}" is ambiguous — name the owner too, e.g. ${matches[0].owner}/${matches[0].name}`);
    process.exit(1);
  }
  return matches[0];
}

export async function run(opts, positionals = []) {
  const { root, manifest, state } = requireWorkspace();
  requireCatalogue(manifest);

  if (!positionals.length) {
    fail(`Nothing named. ${opts.removing ? 'talea rm <repo>' : 'talea add <repo>'}`);
    process.exit(1);
  }

  const targets = positionals.map((n) => resolve(manifest, n));

  // The current list, made explicit. Until now this machine may have been
  // running on the catalogue's defaults; the moment it adds or removes one it
  // has an opinion, and that opinion has to be written down or the next sync
  // would silently undo it.
  const current = new Map(machineRepos(manifest, state).map((r) => [r.name, r]));

  if (opts.removing) {
    heading('Removing from this machine');
    for (const repo of targets) {
      if (!current.delete(repo.name)) {
        skip(`${c.bold(repo.name)} was not on this machine's list`);
        continue;
      }
      const dir = repoDir(manifest, root, repo);
      ok(`${c.bold(repo.name)} ${c.dim('off the list')}`);
      if (existsSync(dir)) {
        plain(`    ${c.dim(`the checkout is still at ${path.relative(root, dir)} — delete it yourself if you want it gone`)}`);
      }
    }
    saveState(root, { ...state, selected: [...current.keys()] });
    return;
  }

  heading('Adding to this machine');
  const added = [];
  for (const repo of targets) {
    if (current.has(repo.name)) {
      skip(`${c.bold(repo.name)} is already on this machine's list`);
      continue;
    }
    current.set(repo.name, repo);
    added.push(repo);
    ok(`${c.bold(repo.name)} ${c.dim(`→ ${path.relative(root, repoDir(manifest, root, repo))}`)}`);
  }

  saveState(root, { ...state, selected: [...current.keys()] });
  if (!added.length) return;

  // Adopt first, in case the repo being added is one already sitting somewhere
  // else on this disk — that is the common case for `add`, not the rare one.
  const adoption = await adoptInPlace({
    manifest,
    root,
    state: { ...state, selected: [...current.keys()] },
    repos: added,
    opts,
  });

  writeDocs(manifest, root, added);

  const todo = withPaths(manifest, root, added).filter(
    (e) => !e.cloned && !adoption.skip.has(e.repo.name),
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
