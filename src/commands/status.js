import path from 'node:path';

import { defaultBranch, groupDir, repoGroup } from '../config.js';
import { aheadBehind, currentBranch, defaultJobs, isDirty, pooled } from '../git.js';
import { c, context, glyph, group, heading, plain, table } from '../log.js';
import { machineRepos, requireWorkspace, selectRepos, withPaths } from '../workspace.js';

export const help = `
${c.bold('talea status')} — one table showing where every repo stands

  ${c.dim('talea status')}                    every repo this machine keeps
  ${c.dim('talea status -g nonstopio')}       only that owner
  ${c.dim('talea status --drift')}            only repos not on their default branch
  ${c.dim('talea status --missing')}          only repos not cloned yet
  ${c.dim('talea status --all')}              the whole catalogue, not just this machine

Columns
  REPO      repository name
  BRANCH    the branch checked out right now
  DEFAULT   the repo's default branch (blank when you are on it)
  STATE     clean / dirty, and commits ahead or behind origin

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names; a bare name works too
      --drift           only repos on some other branch
      --missing         only repos not cloned yet
      --all             ignore this machine's selection
`;

export async function run(opts) {
  const { root, manifest, state } = await requireWorkspace();
  const pool = opts.all ? manifest.repos : machineRepos(manifest, state);
  const entries = withPaths(manifest, root, selectRepos(manifest, opts, pool));

  const rows = await pooled(entries, defaultJobs(), async ({ repo, dir, cloned }) => {
    const home = defaultBranch(repo);
    if (!cloned) {
      return {
        repo,
        missing: true,
        cells: [c.dim(repo.name), c.dim(glyph.rule), c.dim(home ?? glyph.rule), c.yellow('not cloned')],
      };
    }

    const [branch, dirty, delta] = await Promise.all([
      currentBranch(dir),
      isDirty(dir),
      aheadBehind(dir),
    ]);

    // Drift here means "somewhere other than the default branch", which is a
    // fact worth showing and not a problem to fix — most of the time it is
    // exactly where the work is. `--drift` is a filter, never a warning.
    const drift = home != null && branch !== home;
    const bits = [dirty ? c.yellow('dirty') : c.dim('clean')];
    if (delta?.ahead) bits.push(c.cyan(`${glyph.up}${delta.ahead}`));
    if (delta?.behind) bits.push(c.yellow(`${glyph.down}${delta.behind}`));

    return {
      repo,
      drift,
      missing: false,
      cells: [
        c.bold(repo.name),
        drift ? c.cyan(branch ?? '?') : (branch ?? '?'),
        drift ? c.dim(home) : c.dim(''),
        bits.join(' '),
      ],
    };
  });

  let shown = rows;
  if (opts.drift) shown = rows.filter((r) => r.drift && !r.missing);
  if (opts.missing) shown = rows.filter((r) => r.missing);

  heading('Workspace');
  context([
    ['root', c.bold(root)],
    ['repos', `${rows.length}`],
    ['catalogue', c.dim(path.basename(manifest.__source))],
  ]);
  plain('');

  if (shown.length === 0) {
    plain(c.dim('Nothing to show.'));
    return;
  }

  // Grouped by folder, so the table reads like the tree on disk.
  const byGroup = new Map();
  for (const row of shown) {
    const g = repoGroup(row.repo);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(row);
  }

  for (const [name, groupRows] of byGroup) {
    group(`${groupDir(manifest, name)}/`, groupRows.length);
    table(
      groupRows.map((r) => ['  ' + r.cells[0], ...r.cells.slice(1)]),
      ['  REPO', 'BRANCH', 'DEFAULT', 'STATE'],
    );
    plain();
  }

  const missing = rows.filter((r) => r.missing).length;
  const working = rows.filter((r) => r.drift && !r.missing).length;
  const parts = [`${rows.length - missing} cloned`];
  if (missing) parts.push(c.yellow(`${missing} missing`));
  if (working) parts.push(c.cyan(`${working} on another branch`));
  plain(parts.join(c.dim(', ')));
  if (missing) plain(c.dim('Run `talea sync` to get the missing repos.'));
}
