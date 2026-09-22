import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import os from 'node:os';

import {
  STATE_FILE,
  expandHome,
  findWorkspace,
  loadManifest,
  repoGroup,
  saveState,
} from '../config.js';
import { samePath } from '../adopt.js';
import { c, context, fail, heading, info, ok, plain, skip, warn } from '../log.js';
import { run as discover } from './discover.js';
import { run as sync } from './sync.js';
import { rememberWorkspace } from '../workspace.js';

export const help = `
${c.bold('talea init')} — set this machine up

  ${c.dim('talea init')}                      set up ~/Workspace
  ${c.dim('talea init ~/code')}               use that folder as the root instead
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

/**
 * Where the workspace goes.
 *
 * The default is `~/Workspace`, never the current directory. `init` run from
 * the home folder used to make HOME itself the root, which puts owner folders
 * directly in the home directory and points every later scan at three levels of
 * $HOME. It reads as working, so nobody notices until the tree is already
 * spread out.
 *
 * The name comes from the catalogue, so a team that keeps its checkouts under
 * `src/` or `code/` changes one field rather than telling everyone a flag.
 */
export function workspaceTarget(positional, manifest) {
  if (positional) return path.resolve(expandHome(positional));
  return path.join(os.homedir(), manifest?.workspace || 'Workspace');
}

export async function run(opts, positionals = []) {
  const target = workspaceTarget(positionals[0], loadManifest(null));

  // The home directory is not a workspace. Every owner folder would land beside
  // Documents and Downloads, and `adopt` would scan three levels of $HOME on
  // every run. Refused rather than warned: by the time the output scrolls past,
  // the folders exist.
  if (samePath(target, os.homedir())) {
    fail('The home directory cannot be the workspace root.');
    console.error(
      `\n  Owner folders would land beside Documents and Downloads, and every\n` +
        `  scan would walk three levels of your home directory.\n\n` +
        `  Try:  ${c.bold(`talea init ${path.join(os.homedir(), loadManifest(null).workspace || 'Workspace')}`)}`,
    );
    process.exit(1);
  }

  // A workspace inside a workspace: the upward walk stops at the nearest
  // .talea.json, so both would half-work and which one you got would depend on
  // where you were standing.
  const enclosing = findWorkspace(path.dirname(target));
  if (enclosing) {
    warn(`There is already a talea workspace at ${c.bold(enclosing)}.`);
    plain(
      c.dim(
        `  Nesting one inside another means the one you get depends on which\n` +
          `  folder you run from. Remove ${path.join(enclosing, STATE_FILE)} if it is stale.`,
      ),
    );
  }
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
  // So `talea sync` run from outside any workspace knows this one exists.
  rememberWorkspace(target);

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

  // No group folders are created here. `init` runs before the picker — the
  // checklist lives in `sync` — so anything made at this point is made from the
  // catalogue's defaults, which is every owner the discovery found. Picking
  // four repos out of 228 then left 18 empty owner folders in the tree, and an
  // empty folder is indistinguishable from a checkout somebody deleted.
  // `cloneMissing` creates the parent of each repo it is about to clone, so the
  // only folders that ever appear are the ones with something in them.

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
