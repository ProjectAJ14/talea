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
    // A readable `null` or `[]` is not a state either, and every caller reads a
    // field straight off what this returns.
    const state = readJson(USER_STATE);
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
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

// ---------------------------------------------------------------------------
// What a catalogue may say.
//
// A catalogue travels — a gist, a file in a team repo — so it is input, not
// configuration this machine wrote. It decides which repos get cloned and the
// folders they land in, and those folders are created, renamed into and
// written to. So every field that becomes a path is checked before anything
// reads one: a `dir` of "../../outside/app" resolved outside the workspace,
// and `adopt` would have moved a checkout there (found in review). Checked as
// path segments, on both platforms' rules at once, because a catalogue
// written on one machine is read on another.
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why the string `seg` cannot be one folder name, or null when it can. */
function badSegment(seg) {
  if (seg === '') return 'is empty';
  if (seg === '.' || seg === '..') return `is "${seg}", which names no folder of its own`;
  if (/[\\/]/.test(seg)) return 'holds a slash or backslash';
  if (/^[A-Za-z]:/.test(seg)) return 'starts with a drive letter';
  if (seg.includes('\0')) return 'holds a NUL byte';
  return null;
}

/** Why `p` cannot be a relative path below the workspace (`work/api`), or null. */
function badRelative(p) {
  if (typeof p !== 'string') return 'is not a string';
  if (p === '') return 'is empty';
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return 'is an absolute path';
  for (const seg of p.split('/')) {
    const why = badSegment(seg);
    if (why) return `has a part that ${why}`;
  }
  return null;
}

/**
 * Every reason `manifest` is not a usable catalogue, each naming the entry,
 * the field and the fix. Empty means usable.
 *
 * Shape: the fields talea reads have the types it reads them as. Paths: a
 * repo's `name`, `owner` and `dir`, its `group`, and a group's `dir` are all
 * relative and climb nowhere. Collisions: two repos talea manages may not land
 * in one folder, or one inside the other — clone would skip the second as
 * "already there" and sync would report the first's checkout under both. An
 * ignored repo is not placed by talea, so it collides with nothing.
 */
export function catalogueProblems(manifest) {
  if (!isObject(manifest)) return ['the file is not a JSON object'];
  const problems = [];
  const add = (where, field, why, fix) => problems.push(`${where}: "${field}" ${why} — ${fix}`);

  if (manifest.repos !== undefined && !Array.isArray(manifest.repos)) problems.push('"repos" is not an array — it holds one object per repo');
  if (manifest.groups !== undefined && !isObject(manifest.groups)) problems.push('"groups" is not an object — it maps a group name to { "dir", "title" }');
  if (manifest.remotes !== undefined && !(isObject(manifest.remotes) && Object.values(manifest.remotes).every((v) => typeof v === 'string'))) {
    problems.push('"remotes" is not an object of URL templates — e.g. { "ssh": "git@github.com:{owner}/{repo}.git" }');
  }
  if (manifest.workspace !== undefined) {
    const why = badRelative(manifest.workspace);
    if (why) add('the catalogue', 'workspace', why, 'name a folder under your home directory, like "Workspace"');
  }
  if (problems.length) return problems;

  for (const [g, def] of Object.entries(manifest.groups ?? {})) {
    if (!isObject(def)) {
      add(`groups.${g}`, g, 'is not an object', 'write { "dir": "work/api", "title": "…" }, or remove it');
      continue;
    }
    if (def.title !== undefined && typeof def.title !== 'string') add(`groups.${g}`, 'title', 'is not a string', 'write it as text');
    if (def.dir !== undefined) {
      const why = badRelative(def.dir);
      if (why) add(`groups.${g}`, 'dir', why, 'use a folder below the workspace, like "work/api"');
    }
  }

  const placed = [];
  (manifest.repos ?? []).forEach((repo, i) => {
    if (!isObject(repo)) {
      problems.push(`repos[${i}]: is not an object — each repo is { "name", "owner", … }`);
      return;
    }
    const owner = typeof repo.owner === 'string' ? `${repo.owner}/` : '';
    const where = `repos[${i}]${typeof repo.name === 'string' ? ` (${owner}${repo.name})` : ''}`;
    const before = problems.length;
    const segment = (field) => {
      const why = badSegment(repo[field]);
      if (why) add(where, field, why, `use the repo's ${field} as GitHub shows it`);
    };
    if (typeof repo.name !== 'string') add(where, 'name', 'is missing or not a string', 'every repo needs its name');
    else segment('name');
    if (repo.owner !== undefined) {
      if (typeof repo.owner !== 'string') add(where, 'owner', 'is not a string', 'use the GitHub account or org');
      else segment('owner');
    }
    for (const field of ['group', 'dir']) {
      if (repo[field] === undefined) continue;
      const why = badRelative(repo[field]);
      if (why) add(where, field, why, `use a folder below the workspace, like "${field === 'dir' ? 'app' : 'work'}"`);
    }
    for (const field of ['url', 'defaultBranch', 'pushedAt', 'description']) {
      if (repo[field] !== undefined && repo[field] !== null && typeof repo[field] !== 'string') add(where, field, 'is not a string', 'write it as text, or remove it');
    }
    for (const field of ['default', 'ignore', 'archived', 'fork', 'missing']) {
      if (repo[field] !== undefined && typeof repo[field] !== 'boolean') add(where, field, 'is not true or false', `write ${field}: true or leave it out`);
    }
    // `group` and `owner` were checked above, so the folder they name is too.
    const group = repoGroup(repo);
    if (problems.length === before && !repo.ignore) {
      placed.push({ where, rel: [groupDir(manifest, group), repo.dir ?? repo.name].join('/').toLowerCase() });
    }
  });

  // Case-folded: macOS and Windows treat `App` and `app` as one folder.
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      const [x, y] = [placed[a], placed[b]];
      const inside = x.rel === y.rel ? 'both land in' : y.rel.startsWith(`${x.rel}/`) || x.rel.startsWith(`${y.rel}/`) ? 'nest one inside the other at' : null;
      if (inside) {
        problems.push(`${x.where} and ${y.where} ${inside} ${x.rel.length <= y.rel.length ? x.rel : y.rel} — give one of them a "dir" (or "group") of its own`);
      }
    }
  }
  return problems;
}

/** A catalogue that failed `catalogueProblems`, as an error a person can act on. */
export function catalogueError(file, problems) {
  const shown = problems.slice(0, 10).map((p) => `    - ${p}`);
  if (problems.length > 10) shown.push(`    … and ${problems.length - 10} more`);
  return new Error(`${file} is not a usable catalogue:\n${shown.join('\n')}\n\n  Nothing was changed. Fix those entries and run the command again.`);
}

export function loadManifest(workspaceRoot) {
  // The packaged catalogue is the last candidate and always ships, so it is
  // the fallback rather than something to look for.
  const file =
    manifestCandidates(workspaceRoot).slice(0, -1).find((f) => existsSync(f)) ?? PACKAGED_MANIFEST;
  const manifest = readJson(file);
  // Before any command reads a path out of it (see catalogueProblems).
  const problems = catalogueProblems(manifest);
  if (problems.length) throw catalogueError(file, problems);
  manifest.__source = file;
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

/**
 * A repo's identity: `owner/name`, lowercased. The name alone is not one —
 * discovery reaches every org you belong to, and two of them can each have an
 * `app`. Selection state, adoption and every per-repo map key on this.
 */
export const repoId = (repo) => (repo.owner ? `${repo.owner}/${repo.name}` : repo.name).toLowerCase();

/** How a repo is named to a person: its name, or `owner/name` when the catalogue has two. */
export function repoLabel(manifest, repo) {
  const same = manifest?.repos?.filter((r) => r.name.toLowerCase() === repo.name.toLowerCase()) ?? [];
  return same.length > 1 && repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
}

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
