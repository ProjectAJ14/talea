import { existsSync } from 'node:fs';
import path from 'node:path';

import { repoDir, repoLabel } from '../config.js';
import { c, fail } from '../log.js';
import { pickOne } from '../prompt.js';
import { requireWorkspace } from '../workspace.js';

export const help = `
${c.bold('talea where')} — print a repo's path

  ${c.dim('talea where eklavya')}             the absolute path, one line, nothing else
  ${c.dim('dest=$(talea where eklavya) && cd -- "$dest"')}
                                  what it is actually for
  ${c.dim('talea where')}                     the workspace root
  ${c.dim('talea where ek')}                  search: the one cloned repo with "ek" in its
                                  name, or a list to pick from
  ${c.dim('tcd ek')}                          the same, and go there — see ${c.dim('talea shell-init')}

The whole point of a fixed structure is never having to remember it. This is
the command that keeps that promise — the path goes to stdout on its own so it
composes with ${c.dim('cd')}, ${c.dim('code')}, ${c.dim('open')} and anything else that takes a directory.

A word that is not a repo's name searches the repos cloned on this machine. One
match prints its path; several open a list on stderr — arrows, Enter, q — so it
works inside ${c.dim('$( )')}. With no terminal to pick on, several matches are listed and
it exits non-zero rather than choosing.

Exits non-zero, with nothing on stdout, if nothing matches. A
bare ${c.dim('cd $(talea where typo)')} still runs ${c.dim('cd')} with no argument after that, which
goes home — so check it with ${c.dim('&&')} as above, and quote the path for folders with
spaces in them.

Works from outside a workspace too: with one on this machine it uses that, with
several it asks — on stderr, so the answer never ends up in the path.
`;

export async function run(opts, positionals = []) {
  const { root, manifest } = await requireWorkspace();
  const name = positionals[0];

  if (!name) {
    // stdout, not through the logger: this is data, and it is going to be
    // consumed by $( ).
    process.stdout.write(root + '\n');
    return;
  }

  const wanted = name.toLowerCase();
  const exact = manifest.repos.filter(
    (r) => r.name.toLowerCase() === wanted || `${r.owner}/${r.name}`.toLowerCase() === wanted,
  );
  if (exact.length === 1) return found(opts, manifest, root, exact[0]);

  // Not one exact name: search the repos cloned on this machine, so `talea cd
  // ek` finds eklavya. Only cloned ones — a pick that cannot be cd'd into is a
  // dead end. Prefix matches first, because that is usually what was meant.
  const hay = (r) => (wanted.includes('/') ? `${r.owner}/${r.name}` : r.name).toLowerCase();
  const hits = exact.length
    ? exact
    : manifest.repos
        .filter((r) => hay(r).includes(wanted) && existsSync(repoDir(manifest, root, r)))
        .sort((a, b) => hay(b).startsWith(wanted) - hay(a).startsWith(wanted) || a.name.localeCompare(b.name));

  if (!hits.length) {
    // Everything diagnostic goes to stderr, so a failed lookup never puts a
    // stray word on stdout where a shell would try to cd into it.
    fail(`No repo matching "${name}" on this machine.`);
    const near = manifest.repos.filter((r) => hay(r).includes(wanted)).slice(0, 5);
    if (near.length) {
      console.error(`\n  In the catalogue but not cloned: ${near.map((r) => c.bold(repoLabel(manifest, r))).join(', ')}`);
    }
    process.exit(1);
  }
  if (hits.length === 1) return found(opts, manifest, root, hits[0]);

  // Several. A person at a terminal picks; a script stops — choosing for it
  // would be the wrong kind of convenient. The list goes to stderr, so the
  // picker works inside `$(talea where ek)`.
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const labels = hits.map(
      (r) => `${repoLabel(manifest, r).padEnd(24)} ${c.dim(path.relative(root, repoDir(manifest, root, r)))}`,
    );
    let i;
    try {
      i = await pickOne(labels, { title: `${hits.length} repos match "${name}"` });
    } catch {
      i = undefined; // No raw mode on this console: fall through to the list.
    }
    if (i === null) process.exit(1);
    if (i !== undefined) return found(opts, manifest, root, hits[i]);
  }

  fail(
    exact.length
      ? `"${name}" is ambiguous — ${hits.length} repos have that name.`
      : `"${name}" matches ${hits.length} repos.`,
  );
  for (const r of hits) console.error(`    ${c.bold(`${r.owner}/${r.name}`)}`);
  console.error(`\n  Name one: ${c.dim(`talea where ${hits[0].owner}/${hits[0].name}`)}`);
  process.exit(1);
}

function found(opts, manifest, root, repo) {
  const dir = repoDir(manifest, root, repo);
  process.stdout.write(dir + '\n');

  if (!existsSync(dir)) {
    console.error(c.dim(`\n  Not cloned yet — \`talea sync -r ${repoLabel(manifest, repo)}\` will fetch it.`));
    process.exit(1);
  }

  // `talea cd` typed straight at a terminal: no program can move the shell it
  // was started from, so say what can.
  if (opts.as === 'cd' && process.stdout.isTTY) {
    console.error(c.dim(`\n  To move there, add this to your shell's rc file: eval "$(talea shell-init)"`));
  }
}
