// Configuration comes from three places, nearest wins:
//
//   <workspace>/talea.repos.json   a catalogue that belongs to this tree only
//   ~/.talea/talea.repos.json      your catalogue — what `talea discover` writes
//   manifest/talea.repos.json      the packaged one, which ships EMPTY
//
// The packaged manifest is empty on purpose. talea is not a catalogue of
// anybody's repositories; it is the machinery for keeping your own in one
// shape on every machine. Shipping a repo list in the package would make the
// tool personal to whoever published it.
//
//   <workspace>/.talea.json        per-machine state — which repos this machine
//                                  wants, which protocol, where it has looked
//                                  for strays, what it has already moved.
//
// State is never shared. The catalogue is the thing that travels (see
// `talea manifest push`); the selection is the thing that does not.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));

export const MANIFEST_NAME = 'talea.repos.json';
export const STATE_FILE = '.talea.json';

export const PACKAGED_MANIFEST = path.join(here, '..', 'manifest', MANIFEST_NAME);
export const USER_DIR = path.join(os.homedir(), '.talea');
export const USER_MANIFEST = path.join(USER_DIR, MANIFEST_NAME);
export const USER_STATE = path.join(USER_DIR, 'state.json');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Machine-wide state: the update-check stamp, the gist id, the workspace list. Not per workspace. */
export function readUserState() {
  try {
    return readJson(USER_STATE);
  } catch {
    return {};
  }
}

export function writeUserState(state) {
  try {
    mkdirSync(USER_DIR, { recursive: true });
    writeFileSync(USER_STATE, JSON.stringify(state, null, 2) + '\n');
  } catch {
    // A read-only home directory must not break the actual command. The only
    // things kept here are a cache stamp, a gist id and the workspace list,
    // and a lost list re-fills itself the next time a command runs inside one.
  }
}

/** The catalogue files in precedence order, nearest first. */
export function manifestCandidates(workspaceRoot) {
  return [
    workspaceRoot ? path.join(workspaceRoot, MANIFEST_NAME) : null,
    USER_MANIFEST,
    PACKAGED_MANIFEST,
  ].filter(Boolean);
}

export function loadManifest(workspaceRoot) {
  const file = manifestCandidates(workspaceRoot).find((f) => existsSync(f));
  const manifest = file ? readJson(file) : readJson(PACKAGED_MANIFEST);
  manifest.__source = file ?? PACKAGED_MANIFEST;
  manifest.repos ??= [];
  manifest.groups ??= {};
  return manifest;
}

/** Write the catalogue back to wherever it was loaded from, or to the user one. */
export function saveManifest(manifest, file) {
  const dest =
    file ?? (manifest.__source === PACKAGED_MANIFEST ? USER_MANIFEST : manifest.__source) ?? USER_MANIFEST;
  const { __source, ...body } = manifest;
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(body, null, 2) + '\n');
  return dest;
}

/**
 * Find the workspace root by walking up from `start` looking for .talea.json.
 * Mirrors how git finds .git, so commands work from anywhere inside the tree —
 * including from inside one of the repos it manages.
 */
export function findWorkspace(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, STATE_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every workspace this machine has set up, as recorded in ~/.talea/state.json.
 *
 * This is what lets `talea sync` run from anywhere: outside a workspace the
 * upward walk finds nothing, and this list is what is left to ask. Kept in the
 * machine-wide state rather than the catalogue because a path on this laptop
 * means nothing on the next one. Entries whose .talea.json has gone are skipped
 * on read, not dropped on write — a deleted workspace stops being offered, but
 * an unplugged drive that comes back has not been forgotten.
 */
export const knownWorkspaces = () =>
  (readUserState().workspaces ?? []).filter((dir) => existsSync(path.join(dir, STATE_FILE)));

export function loadState(workspaceRoot) {
  const file = path.join(workspaceRoot, STATE_FILE);
  return existsSync(file) ? readJson(file) : {};
}

export function saveState(workspaceRoot, state) {
  const file = path.join(workspaceRoot, STATE_FILE);
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** Expand `~` so `talea init ~/Workspace` behaves the same on every shell. */
export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * The clone URL for a repo: an explicit override, else the host template with
 * the repo's own owner filled in.
 *
 * `{owner}` is per repo rather than per manifest, which is the whole reason one
 * catalogue can hold your personal repos and three orgs' repos at once.
 */
export function repoUrl(manifest, repo, protocol = 'ssh') {
  if (repo.url) return repo.url;
  const template = manifest.remotes?.[protocol];
  if (!template) {
    throw new Error(
      `Unknown remote protocol "${protocol}". Known: ${Object.keys(manifest.remotes ?? {}).join(', ')}`,
    );
  }
  return template.replace('{owner}', repo.owner ?? '').replace('{repo}', repo.name);
}

/**
 * The folder a group lives in. Equal to the catalogue key until a group is
 * nested (`work/backend`), at which point printing the key names no real folder.
 */
export const groupDir = (manifest, group) => manifest.groups?.[group]?.dir ?? group;

/** A repo's group: explicit, else its owner — so a fresh catalogue needs no curation. */
export const repoGroup = (repo) => repo.group ?? repo.owner ?? 'repos';

export const repoDir = (manifest, workspaceRoot, repo) =>
  path.join(workspaceRoot, groupDir(manifest, repoGroup(repo)), repo.dir ?? repo.name);

/**
 * The branch this repo is cloned on and fast-forwarded against.
 *
 * Recorded per repo by `talea discover`, because GitHub is the only thing that
 * knows — assuming `main` is wrong for every repo cut before 2020 and for
 * anyone whose default is `master`, `develop` or `trunk`. Never guessed: a repo
 * with nothing recorded is cloned on whatever the server hands over.
 */
export const defaultBranch = (repo) => repo.defaultBranch ?? null;
