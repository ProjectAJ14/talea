import { findWorkspace, groupDir, loadManifest, loadState, repoGroup } from '../config.js';
import { c, glyph, group, heading, plain, table } from '../log.js';
import { machineRepos, selectRepos } from '../workspace.js';

export const help = `
${c.bold('talea list')} — show the catalogue

  ${c.dim('talea list')}                      every repo, grouped by folder
  ${c.dim('talea list -g nonstopio')}         one owner
  ${c.dim('talea list --groups')}             just the group summary
  ${c.dim('talea list --json')}               machine-readable output

The ${c.bold('KEEP')} column is this machine: ${glyph.ok} kept, blank not. The ${c.bold('DEFAULT')} column is
the catalogue's opinion — what a brand new machine would start with.

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names
      --all             include archived and quiet repos (default: hidden)
      --groups          show groups only
      --json            emit JSON
`;

export function run(opts) {
  // Readable from anywhere. Listing the catalogue is not a workspace operation
  // — on a fresh machine it is the thing you run *before* `talea init`, to see
  // what you are about to be offered.
  const root = findWorkspace();
  const manifest = loadManifest(root);
  const state = root ? loadState(root) : {};
  const kept = new Set(machineRepos(manifest, state).map((r) => r.name));

  let repos = selectRepos(manifest, opts, manifest.repos);
  if (!opts.all) repos = repos.filter((r) => !r.archived || kept.has(r.name));

  if (opts.json) {
    // Data, so stdout and nothing else — this is what a script reads.
    process.stdout.write(
      JSON.stringify(
        repos.map((r) => ({ ...r, group: repoGroup(r), kept: kept.has(r.name) })),
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const byGroup = new Map();
  for (const r of repos) {
    const g = repoGroup(r);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }

  if (opts.groups) {
    heading('Groups');
    table(
      [...byGroup.entries()].map(([g, members]) => [
        c.bold(`${groupDir(manifest, g)}/`),
        `${members.length}`,
        c.dim(`${members.filter((r) => kept.has(r.name)).length} kept here`),
      ]),
      ['GROUP', 'REPOS', ''],
    );
    return;
  }

  heading(`Catalogue ${c.dim(manifest.__source)}`);

  for (const [g, members] of byGroup) {
    plain('');
    group(`${groupDir(manifest, g)}/`, members.length);
    table(
      members.map((r) => [
        '  ' + (kept.has(r.name) ? c.bold(r.name) : c.dim(r.name)),
        kept.has(r.name) ? c.green(glyph.ok) : c.dim(''),
        r.default ? c.dim('default') : c.dim(''),
        c.dim(r.defaultBranch ?? '?'),
        [
          r.private ? c.dim('private') : '',
          r.fork ? c.dim('fork') : '',
          r.archived ? c.yellow('quiet') : '',
          r.missing ? c.yellow('not on github') : '',
          r.ignore ? c.yellow('ignored') : '',
        ]
          .filter(Boolean)
          .join(' '),
      ]),
      ['  REPO', 'KEEP', 'DEFAULT', 'BRANCH', ''],
    );
  }

  const hidden = manifest.repos.length - repos.length;
  plain('');
  plain(
    c.dim(
      `${repos.length} shown, ${kept.size} kept on this machine` +
        (hidden > 0 ? `, ${hidden} quiet (--all to show)` : ''),
    ),
  );
}
