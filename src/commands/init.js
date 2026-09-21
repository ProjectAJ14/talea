import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  STATE_FILE,
  expandHome,
  groupDir,
  loadManifest,
  loadState,
  repoGroup,
  saveState,
} from '../config.js';
import { machineRepos } from '../workspace.js';
import { c, context, heading, info, ok, plain, skip, warn } from '../log.js';
import { run as discover } from './discover.js';
import { run as sync } from './sync.js';

export const help = `
${c.bold('talea init')} — set this machine up

  ${c.dim('talea init')}                      use the current folder as the workspace
  ${c.dim('talea init ~/Workspace')}          use that folder instead
  ${c.dim('talea init --no-clone')}           write the config, clone later

Creates the workspace, records this machine's preferences in ${STATE_FILE}, asks
what this machine should keep, and fills it.

If the catalogue is empty, ${c.dim('talea discover')} runs first — so on your very first
machine this one command goes from nothing to a folder tree.

Options
      --protocol <p>    ssh (default) or https
      --no-clone        create the workspace without cloning
      --pick            go straight to the checklist, skipping the defaults offer
  -g, --group <names>   restrict to these groups
  -j, --jobs <n>        parallel clones

${c.bold('On your second machine')}, pull the catalogue first:

  ${c.dim('talea manifest pull <gist-id>')}
  ${c.dim('talea init ~/Workspace')}
`;

export async function run(opts, positionals = []) {
  const target = path.resolve(expandHome(positionals[0] ?? process.cwd()));
  const stateFile = path.join(target, STATE_FILE);
  const fresh = !existsSync(stateFile);

  heading(fresh ? `Creating a workspace at ${target}` : `Workspace already at ${target}`);

  mkdirSync(target, { recursive: true });

  if (fresh) {
    // Written before anything else: every other command finds the workspace by
    // walking up to this file, so until it exists `talea sync` run from inside
    // the folder we just made would not know it is in one.
    saveState(target, { protocol: opts.protocol ?? 'ssh', createdAt: new Date().toISOString() });
    ok(`${STATE_FILE} ${c.dim('— this machine’s own state, never shared')}`);
  } else {
    skip(`${STATE_FILE} already here, leaving it alone`);
  }

  let manifest = loadManifest(target);

  if (!manifest.repos.length) {
    info('The catalogue is empty — discovering your repos from GitHub.');
    plain('');
    await discover({ ...opts, apply: true });
    manifest = loadManifest(target);
    if (!manifest.repos.length) {
      warn('Still nothing in the catalogue. Nothing to clone.');
      return;
    }
  }

  const groups = [...new Set(manifest.repos.map((r) => repoGroup(r)))];
  context([
    ['catalogue', c.dim(manifest.__source)],
    ['repos', `${manifest.repos.length}`],
    ['groups', `${groups.length}`],
  ]);

  // The group folders for the repos this machine will actually hold — not one
  // per owner in the catalogue. A collaborator repo you never clone should not
  // leave an empty folder in the tree forever.
  const mine = machineRepos(manifest, loadState(target));
  for (const g of new Set(mine.map((r) => repoGroup(r)))) {
    mkdirSync(path.join(target, groupDir(manifest, g)), { recursive: true });
  }

  if (opts.clone === false) {
    plain(`\n${c.dim('Workspace ready. Run `talea sync` when you want the repos.')}`);
    return;
  }

  // `sync` finds the workspace by walking up from cwd, and cwd is wherever the
  // developer typed the command — which is not necessarily inside the folder
  // they just named.
  const back = process.cwd();
  try {
    process.chdir(target);
    await sync(opts);
  } finally {
    process.chdir(back);
  }
}
