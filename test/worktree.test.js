// Moving a repo that has worktrees.
//
// Real git, real directories: the thing under test is what git records on disk
// and whether it still resolves afterwards, which a mock cannot tell you. The
// repos are throwaway and local — nothing here reaches a network.

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeMove, linkedWorktrees, remapWorktree, siblingWorktreeDir } from '../src/adopt.js';

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let tmp;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'talea-wt-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A repo with three worktrees, one of each kind that has to survive a move:
 * nested inside the repo, in the sibling `<repo>-worktrees/` folder, and one
 * somewhere else entirely.
 */
function makeRepo(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);

  const nested = path.join(dir, '.claude', 'worktrees', 'inside');
  const sibling = path.join(siblingWorktreeDir(dir), 'beside');
  const elsewhere = path.join(tmp, `${name}-far-away`);

  git(['worktree', 'add', '-q', '-b', 'inside', nested], dir);
  git(['worktree', 'add', '-q', '-b', 'beside', sibling], dir);
  git(['worktree', 'add', '-q', '-b', 'far', elsewhere], dir);

  return { dir, nested, sibling, elsewhere };
}

/** Does this worktree still resolve back to its repo? */
const resolves = (wt) => {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], wt).trim() === 'true';
  } catch {
    return false;
  }
};

describe('a repo with worktrees can be moved', () => {
  test('the repo moves and every worktree still resolves', () => {
    const { dir, nested, sibling, elsewhere } = makeRepo('movable');
    const to = path.join(tmp, 'landing', 'movable');

    // Uncommitted work in a worktree, because the move must not cost it.
    writeFileSync(path.join(elsewhere, 'SCRATCH.txt'), 'unsaved\n');

    const res = executeMove({ from: dir, to });
    assert.equal(res.ok, true, res.message);
    assert.equal(existsSync(to), true);
    assert.equal(existsSync(dir), false);

    // Nested: travelled with the rename.
    const movedNested = path.join(to, '.claude', 'worktrees', 'inside');
    assert.equal(resolves(movedNested), true, 'nested worktree lost its repo');

    // Sibling: the whole <repo>-worktrees folder came along.
    assert.equal(res.worktrees.siblings.to, siblingWorktreeDir(to));
    assert.equal(existsSync(siblingWorktreeDir(dir)), false, 'old sibling folder left behind');
    assert.equal(resolves(path.join(siblingWorktreeDir(to), 'beside')), true);

    // Elsewhere: did not move, and was repaired where it sits.
    assert.equal(existsSync(elsewhere), true, 'an unrelated path must not be moved');
    assert.equal(resolves(elsewhere), true, 'external worktree lost its repo');
    assert.equal(
      existsSync(path.join(elsewhere, 'SCRATCH.txt')),
      true,
      'uncommitted work in a worktree was lost',
    );

    // And the repo agrees, from its side, about all three.
    const listed = git(['worktree', 'list', '--porcelain'], to);
    assert.equal(linkedWorktrees(listed).length, 3);
    for (const p of linkedWorktrees(listed)) {
      assert.equal(existsSync(p), true, `repo still points at a gone path: ${p}`);
    }

    assert.equal(res.worktrees.repaired.length, 3);
    void sibling;
    void nested;
  });

  test('an occupied sibling destination leaves the folder alone rather than merging', () => {
    // Nothing in this module overwrites anything. A folder already at the
    // destination belongs to the developer.
    const { dir } = makeRepo('occupied');
    const to = path.join(tmp, 'landing2', 'occupied');
    mkdirSync(siblingWorktreeDir(to), { recursive: true });
    writeFileSync(path.join(siblingWorktreeDir(to), 'THEIRS.txt'), 'do not touch\n');

    const res = executeMove({ from: dir, to });
    assert.equal(res.ok, true, res.message);
    assert.equal(res.worktrees.siblings, null, 'it moved onto an occupied folder');
    assert.equal(
      existsSync(path.join(siblingWorktreeDir(to), 'THEIRS.txt')),
      true,
      'it clobbered a folder that was already there',
    );
    // The worktree stayed beside the old location, and still works.
    assert.equal(resolves(path.join(siblingWorktreeDir(dir), 'beside')), true);
  });
});

describe('where a worktree ends up', () => {
  const from = path.join('/ws', 'old', 'repo');
  const to = path.join('/ws', 'owner', 'repo');
  const siblings = { from: siblingWorktreeDir(from), to: siblingWorktreeDir(to) };

  test('one nested in the repo travels with it', () => {
    assert.equal(
      remapWorktree(path.join(from, '.claude', 'worktrees', 'x'), { from, to, siblings }),
      path.join(to, '.claude', 'worktrees', 'x'),
    );
  });

  test('one in the sibling folder follows that folder', () => {
    assert.equal(
      remapWorktree(path.join(siblings.from, 'feature'), { from, to, siblings }),
      path.join(siblings.to, 'feature'),
    );
  });

  test('one anywhere else does not move', () => {
    const far = path.join('/somewhere', 'else');
    assert.equal(remapWorktree(far, { from, to, siblings }), far);
  });

  test('with no sibling folder moved, only the nested one is remapped', () => {
    const beside = path.join(siblings.from, 'feature');
    assert.equal(remapWorktree(beside, { from, to, siblings: null }), beside);
  });

  test('the sibling folder is a suffix on the repo path, not a folder inside it', () => {
    // `<repo>-worktrees`, not `<repo>/worktrees`. Getting this wrong would put
    // the worktrees inside the repo and have git track them.
    assert.equal(siblingWorktreeDir('/ws/owner/repo'), '/ws/owner/repo-worktrees');
  });
});

describe('what linkedWorktrees reports', () => {
  test('the main checkout is not one of them', () => {
    const porcelain = 'worktree /a/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /a/repo-worktrees/x\nHEAD def\nbranch refs/heads/x\n';
    assert.deepEqual(linkedWorktrees(porcelain), ['/a/repo-worktrees/x']);
  });

  test('a prunable registration is skipped — there is no path left to repair', () => {
    const porcelain =
      'worktree /a/repo\nHEAD abc\n\nworktree /gone\nHEAD def\nprunable gitdir file points to non-existent location\n';
    assert.deepEqual(linkedWorktrees(porcelain), []);
  });
});
