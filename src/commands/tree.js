// The folder tree as it is on disk, with a CLAUDE.md marker on every level.
//
// `status` answers "what branch is this on"; `tree` answers "where does this
// live, and is there a doc there". The group folders are not repos, so nothing
// else in the tool ever shows them as folders — and they are exactly the levels
// whose CLAUDE.md is easy to lose, being outside every git repo. See src/docs.js.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { repoPlace } from '../config.js';
import { c, context, folderTree, glyph, heading, icon, plain, table } from '../log.js';
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
  -r, --repo <names>    repo names or owner/name, comma-separated; a bare name works too
      --all             the whole catalogue, not just what this machine keeps
`;

const hasDoc = (dir) => existsSync(path.join(dir, 'CLAUDE.md'));

export async function run(opts) {
  const { root, manifest, state } = await requireWorkspace();
  const pool = opts.all ? manifest.repos : machineRepos(manifest, state);
  const entries = withPaths(manifest, root, selectRepos(manifest, opts, pool, { includeIgnored: true }));

  // Laid out by the same folderTree() the live board draws from, so `sync`
  // and `tree` show one picture: work/api and work/web share one work node,
  // and siblings are sorted, because this claims to show the folders on disk
  // and `ls` does not print them in catalogue order.
  const lines = folderTree(
    entries.map((e) => {
      const { group, name } = repoPlace(manifest, e.repo);
      return { ...e, path: group.split('/'), name };
    }),
  );
  const rows = lines.map(({ prefix, item, folder, path: segs }) => {
    const dir = item ? item.dir : path.join(root, ...segs);
    const label = item ? (item.cloned ? c.bold(item.name) : c.dim(item.name)) : c.bold(`${folder}/`);
    return {
      folder: !item,
      missing: !hasDoc(dir),
      cells: [
        c.dim(prefix) + label,
        hasDoc(dir) ? `${icon.ok} CLAUDE.md` : c.dim(`${glyph.pending} no CLAUDE.md`),
        item && !item.cloned ? c.yellow('not cloned') : '',
      ],
    };
  });

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
