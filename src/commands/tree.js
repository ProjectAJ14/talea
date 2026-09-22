// The folder tree as it is on disk, with a CLAUDE.md marker on every level.
//
// `status` answers "what branch is this on"; `tree` answers "where does this
// live, and is there a doc there". The group folders are not repos, so nothing
// else in the tool ever shows them as folders — and they are exactly the levels
// whose CLAUDE.md is easy to lose, being outside every git repo. See src/docs.js.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { groupDir, repoGroup } from '../config.js';
import { c, context, glyph, heading, icon, plain, table } from '../log.js';
import { machineRepos, requireWorkspace, selectRepos, withPaths } from '../workspace.js';

export const help = `
${c.bold('talea tree')} — the workspace folder tree, and who has a CLAUDE.md

  ${c.dim('talea tree')}                     the whole workspace
  ${c.dim('talea tree -g nonstopio')}        one owner

Every folder from the workspace root down to each repo is listed, with a marker
saying whether a ${c.bold('CLAUDE.md')} sits in it. The group folders are not git repos, so
their docs come from the CLI — run \`talea sync\` to drop in any that are new.

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names
      --all             the whole catalogue, not just what this machine keeps
`;

const hasDoc = (dir) => existsSync(path.join(dir, 'CLAUDE.md'));

export async function run(opts) {
  const { root, manifest, state } = await requireWorkspace();
  const pool = opts.all ? manifest.repos : machineRepos(manifest, state);
  const entries = withPaths(manifest, root, selectRepos(manifest, opts, pool));

  // A node per folder, keyed by path segment, so work/api and work/web share
  // the one work node instead of printing it twice.
  const make = (dir) => ({ dir, children: new Map() });
  const tree = make(root);

  for (const { repo, dir, cloned } of entries) {
    let node = tree;
    for (const seg of groupDir(manifest, repoGroup(repo)).split('/')) {
      if (!node.children.has(seg)) node.children.set(seg, make(path.join(node.dir, seg)));
      node = node.children.get(seg);
    }
    node.children.set(path.basename(dir), { ...make(dir), repo, cloned });
  }

  const rows = [];
  const walk = (node, prefix) => {
    // Sorted, because this claims to show the folders on disk and `ls` does
    // not print them in catalogue order.
    const kids = [...node.children.entries()].sort(([a], [b]) =>
      a.localeCompare(b, 'en', { sensitivity: 'base' }),
    );
    kids.forEach(([name, kid], i) => {
      const last = i === kids.length - 1;
      const branch = c.dim(last ? '└─ ' : '├─ ');
      const label = kid.repo
        ? kid.cloned
          ? c.bold(name)
          : c.dim(name)
        : c.bold(`${name}/`);
      rows.push({
        folder: !kid.repo,
        missing: !hasDoc(kid.dir),
        cells: [
          prefix + branch + label,
          hasDoc(kid.dir) ? `${icon.ok} CLAUDE.md` : c.dim(`${glyph.pending} no CLAUDE.md`),
          kid.repo && !kid.cloned ? c.yellow('not cloned') : '',
        ],
      });
      walk(kid, prefix + c.dim(last ? '   ' : '│  '));
    });
  };
  walk(tree, '');

  heading('Workspace');
  context([
    ['root', c.bold(root)],
    ['repos', `${entries.length}`],
  ]);
  plain('');
  table(
    [
      [c.bold(`${path.basename(root)}/`), hasDoc(root) ? `${icon.ok} CLAUDE.md` : c.dim(`${glyph.pending} no CLAUDE.md`), ''],
      ...rows.map((r) => r.cells),
    ],
  );

  // Only the group folders are counted: a repo's own CLAUDE.md is whoever
  // wrote it's business, but a missing group one is a file `sync` can drop in.
  const gaps = rows.filter((r) => r.folder && r.missing).length + (hasDoc(root) ? 0 : 1);
  plain();
  plain(
    gaps
      ? c.dim(`${gaps} folder${gaps === 1 ? '' : 's'} without a CLAUDE.md — \`talea sync\` writes the ones that ship with the CLI`)
      : c.dim('every folder has a CLAUDE.md'),
  );
}
