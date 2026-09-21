// The CLAUDE.md files that describe a *folder of repos* rather than a repo.
//
// `ProjectAJ14/`, `nonstopio/`, `work/backend/` — the folders repos get cloned
// into — are not git repositories. So nothing can version the doc that says what
// lives in one, and every machine would have to be handed the file. The
// templates therefore ship with this package and `talea clone` drops them into
// place, keyed by group name: `templates/<GROUP>.CLAUDE.md`, plus
// `templates/root.CLAUDE.md` for the workspace root.
//
// talea ships NO templates. The mechanism is here so that adding a doc is
// adding a file; until one exists this writes nothing.
//
// Repo-level CLAUDE.md files are not our business: a committed one arrives with
// the clone, and a gitignored one belongs to whoever wrote it.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupDir } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = path.join(here, '..', 'templates');

/** The template for a group, or for the workspace root when group is null. */
export const templateFor = (group) =>
  path.join(TEMPLATES, `${group ?? 'root'}.CLAUDE.md`);

/**
 * Every folder a group's docs belong in, innermost last: `work/backend` is the
 * group, but `work/` above it is a real folder that no group owns and nothing
 * else would ever document. Keyed by folder name, so `work.CLAUDE.md` is the
 * only wiring a parent folder needs.
 *
 * A group's `dir` is catalogue data, and a typo in it used to be silent in two
 * different ways — both of which cost the workspace-root doc, which is outside
 * git and therefore unrecoverable:
 *
 *   dir: "./work/api"    `path.join(root, ".")` is `root`, so the group's own
 *                        key displaced the root's entry in `targets`;
 *                        `templateFor(".")` names no file, the write was
 *                        skipped, and the root CLAUDE.md was never written.
 *   dir: "" or "."       same collapse, except the key that lands on `root` is
 *                        the GROUP's — so the workspace root was handed the
 *                        group's doc. Never overwritten afterwards, so the
 *                        wrong file at the root became permanent.
 *
 * Both are a malformed catalogue, so they are an error now. "Fail loudly on
 * typos" is rule 5 for exactly this: a bulk command that quietly does the wrong
 * thing is worse than one that stops.
 */
function docFolders(dir, group) {
  // Split on '/' only: catalogue dirs are authored with forward slashes on
  // every platform. Quietly accepting a backslash here would be papering over a
  // different typo, and this function's job is to refuse them.
  const raw = String(dir ?? '');
  const segs = raw.split('/');
  const usable =
    segs.every((seg) => seg !== '' && seg !== '.' && seg !== '..') && !path.isAbsolute(raw);

  if (!usable) {
    throw new Error(
      `Group "${group}" has an unusable dir ${JSON.stringify(dir)}.\n` +
        '  A group dir must be a relative path below the workspace root, like "work/api".\n' +
        '  Fix it in the catalogue (manifest/talea.repos.json).',
    );
  }

  return segs.map((seg, i) => [
    i === segs.length - 1 ? group : seg,
    segs.slice(0, i + 1),
  ]);
}

/**
 * Write the workspace-root, parent-folder and per-group CLAUDE.md files that
 * have a template.
 *
 * **Never overwrites.** These files are outside git by design, so an overwrite
 * cannot be recovered — a developer's own edits to their own untracked doc
 * outrank the packaged copy every time. A group with no template is skipped,
 * which is how a group opts out — though for a nested group that means deleting
 * the parent's template too (`PORTAL.CLAUDE.md` is reached through V1's and
 * V2's `dir`, not through either group's own name).
 *
 * Throws on a group whose `dir` cannot name a folder below the root. See
 * `docFolders`.
 */
export function dropDocs(manifest, root, groups) {
  // Keyed by folder so a parent shared by two groups (`PORTAL/` under both V1
  // and V2) is considered once.
  const targets = new Map([[root, null]]);
  for (const g of [...groups].sort()) {
    for (const [key, segs] of docFolders(groupDir(manifest, g), g)) {
      // `docFolders` guarantees at least one segment that is not '', '.' or
      // '..', so this can never join back to `root` and displace its entry —
      // which is how the root doc used to go missing. The guarantee lives
      // there, with a test, rather than as an unreachable guard here.
      targets.set(path.join(root, ...segs), key);
    }
  }

  const written = [];
  const kept = [];

  for (const [dir, group] of targets) {
    const src = templateFor(group);
    if (!existsSync(src)) continue;

    const dst = path.join(dir, 'CLAUDE.md');
    if (existsSync(dst)) {
      kept.push(dst);
      continue;
    }

    mkdirSync(dir, { recursive: true });
    copyFileSync(src, dst);
    written.push(dst);
  }

  return { written, kept };
}
