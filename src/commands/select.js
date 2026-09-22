// `talea select` — reopen the checklist and change what this machine keeps.
//
// `add` and `rm` are the one-repo door. This is the door for "let me look at
// the whole list again", which until now was reachable only as `--pick` on a
// command you had to already know to run. The picker was the first thing `init`
// showed and then had no name of its own.
//
// It is deliberately thin: the picking and the saving live in `src/select.js`
// because `clone` and `sync` ask the same question, and the cloning is
// `clone.run`, re-entered after the new selection is on disk.

import { c, fail, heading, ok, plain, skip, warn } from '../log.js';
import { chooseRepos } from '../select.js';
import { machineRepos, requireCatalogue, requireWorkspace } from '../workspace.js';
import * as add from './add.js';
import * as clone from './clone.js';

export const help = `
${c.bold('talea select')} — change what this machine keeps

  ${c.dim('talea select')}              reopen the checklist, then clone what is newly ticked
  ${c.dim('talea select --no-clone')}   change the list only, fill it in later
  ${c.dim('talea pick PiDom')}          keep that one repo and clone it — or, if no repo
                            has that name, open the checklist instead

The checklist opens with the current selection ticked. Space toggles, Enter
saves, Esc cancels and changes nothing. Everything in the catalogue is listed,
including the archived and the forks — this machine is allowed to keep
something the default set does not have.

It writes ${c.dim('.talea.json')}, which never leaves this machine, so no other machine's
selection changes. Unticking a repo takes it off the list and leaves the
checkout exactly where it is; deleting it is your call.

A name that matches exactly one repo (case does not matter, ${c.dim('owner/name')} works)
is ${c.dim('talea add <repo>')}. A name that matches none, or two owners' repos, opens the
checklist, because a typo should land you in the list rather than nowhere.
${c.dim('talea rm <repo>')} takes one off.

Options
      --no-clone        save the selection, clone nothing
      --protocol <p>    ssh (default) or https
  -j, --jobs <n>        parallel clones
`;

/** The names that do not pin down exactly one repo — empty means every one does. */
export function unresolved(manifest, names) {
  return names.filter((n) => add.lookup(manifest, n).length !== 1);
}

/** What changed, as two lists of names. Pure, so it can be tested. */
export function changes(before, after) {
  const had = new Set(before);
  const has = new Set(after);
  return {
    added: after.filter((n) => !had.has(n)),
    dropped: before.filter((n) => !has.has(n)),
  };
}

export async function run(opts, positionals = []) {
  const { root, manifest, state } = await requireWorkspace();
  requireCatalogue(manifest);

  // -g/-r narrow a run; they cannot narrow a decision about the whole machine.
  // Accepting them silently would return the old selection unchanged and look
  // like the picker had simply declined to open.
  if (opts.group || opts.repo) {
    fail('`select` is about the whole list — -g/-r do not narrow it.');
    console.error('\n  Use `talea add <repo>` or `talea rm <repo>` for one repo at a time.');
    process.exit(1);
  }

  if (positionals.length) {
    const missing = unresolved(manifest, positionals);
    if (!missing.length) return add.run({ ...opts, removing: false }, positionals);
    warn(`No single repo called ${missing.map((n) => `"${n}"`).join(', ')} — opening the checklist.`);
  }

  const before = machineRepos(manifest, state).map((r) => r.name);
  const { repos } = await chooseRepos({ manifest, root, state, opts: { ...opts, pick: true } });
  const after = repos.map((r) => r.name);
  const { added, dropped } = changes(before, after);

  heading('This machine keeps');
  for (const name of added) ok(`${c.bold(name)} ${c.dim('added')}`);
  for (const name of dropped) {
    skip(`${c.bold(name)} ${c.dim('off the list — the checkout stays where it is')}`);
  }
  plain(c.dim(`    ${after.length} repos`));

  if (!added.length || opts.clone === false) return;

  // The selection is on disk now, so clone reads it back and never re-asks.
  await clone.run({ ...opts, pick: false });
}
