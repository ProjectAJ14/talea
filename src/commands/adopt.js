import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandHome, loadState, saveState } from '../config.js';
import { c, fail, glyph, heading, icon, info, ok, plain, skip, summary, warn } from '../log.js';
import { requireCatalogue, requireWorkspace, selectRepos } from '../workspace.js';
import {
  DUPLICATES_DIR,
  claudeMaybeRunning,
  executeMove,
  parkingSpot,
  findConfigHits,
  findGitDirs,
  moveClaudeSessions,
  planAdoptions,
  readOrigins,
  rekeyClaudeJson,
  rewriteConfigFile,
  unfixablePaths,
} from '../adopt.js';
import { git } from '../git.js';

export const help = `
${c.bold('talea adopt')} — move repos you already have into the right place

  ${c.dim('talea adopt')}                        show what would move
  ${c.dim('talea adopt --apply')}                actually move it
  ${c.dim('talea adopt --from ~/Desktop')}       also look there for checkouts
  ${c.dim('talea adopt -r eklavya --apply')}

Repos are matched by their ${c.bold('git remote')}, never by folder name, so a checkout
called ${c.dim('~/tmp/clone2')} is still recognised as the repo it holds. A matched repo in the wrong place is
${c.bold('moved')}, never re-cloned — the move keeps every branch, stash, reflog entry
and uncommitted change exactly as it is.

A repo that cannot be moved safely (a linked worktree, extra worktrees, an
occupied destination, another filesystem) is left alone and the reason is
printed.

When the same repo is found twice, the copy at the catalogue path wins and the
other moves into ${c.bold(DUPLICATES_DIR)}/ — never deleted, never left outside the tree.
Whatever it holds (branches, stashes, uncommitted work) comes with it, and is
listed so you can decide what to do with it.

After a move, absolute paths that pointed at the old location are repaired:
Claude Code session history and memory, its per-project settings, and config
files in the workspace and the repo (.idea, .vscode, .claude, CLAUDE.md).

Options
  -g, --group <names>   restrict to groups
  -r, --repo <names>    restrict to repos
      --from <path>     extra folder to search (repeatable, remembered)
      --apply           perform the moves (default is a dry run)
      --fix-paths       re-repair config for repos already adopted, moving nothing
  -j, --jobs <n>        parallel git calls (default 8)
`;

/**
 * Scan, match, and optionally move. Exported so `clone` can adopt before it
 * clones — a repo the developer already has must never be cloned twice.
 */
export async function planFor({ manifest, root, repos, scanRoots, jobs = 8 }) {
  const dirs = findGitDirs(scanRoots, 3);
  const candidates = await readOrigins(dirs, jobs);
  const plans = await planAdoptions(manifest, root, repos, candidates);

  return {
    plans,
    moves: plans.filter((p) => p.action === 'move'),
    parks: plans.filter((p) => p.action === 'park'),
    refused: plans.filter((p) => p.action === 'refuse'),
    inPlace: plans.filter((p) => p.action === 'in-place'),
  };
}

/**
 * Perform the moves and repair the paths that pointed at the old locations.
 *
 * Every successful move is appended to `.talea.json`, both as an audit trail
 * and so `--fix-paths` can repair the config again later. That matters because
 * a running Claude Code process rewrites ~/.claude.json when it exits and can
 * revert the repair — and by then the repo is in place, so a plain re-run would
 * find nothing to do.
 */
export async function applyMoves(root, moves, parks = [], manifest) {
  const results = [];
  const warnedAboutClaude = moves.length > 0 && claudeMaybeRunning();

  for (const plan of moves) {
    const res = executeMove(plan);
    if (!res.ok) {
      fail(`${c.bold(plan.repo.name)}\n    ${c.dim(res.message)}`);
      results.push({ plan, ok: false });
      continue;
    }
    ok(
      `${c.bold(plan.repo.name)} ${c.dim(shorten(plan.from))} ${icon.arrow} ${c.dim(path.relative(root, plan.to))}`,
    );
    const repairs = repairPaths(root, plan);
    results.push({ plan, ok: true, repairs });
  }

  // Second copies move only once the winner is actually in place. Ordering
  // alone does not achieve that — a move that failed leaves the catalogue path
  // empty, and parking on top of that strands one copy and hides the other, so
  // the winner's arrival is checked rather than assumed.
  const parked = [];
  const failedMoves = new Set(
    results.filter((r) => !r.ok).map((r) => path.resolve(r.plan.to)),
  );

  for (const plan of parks) {
    const winner = path.resolve(plan.keeping);
    if (failedMoves.has(winner) || !existsSync(winner)) {
      warn(
        `${c.bold(plan.repo.name)} second copy left where it is — ` +
          `${path.relative(root, plan.keeping) || plan.keeping} is not in place\n    ${c.dim(shorten(plan.from))}`,
      );
      continue;
    }

    // The spot is chosen now, not at plan time: two copies of one repo planned
    // in the same run would otherwise be handed the identical path, and the
    // -2 suffixing would never fire.
    const res = executeMove({ ...plan, to: parkingSpot(root, plan.repo, manifest) });
    if (!res.ok) {
      fail(`${c.bold(plan.repo.name)} second copy\n    ${c.dim(res.message)}`);
      continue;
    }
    parked.push({ ...plan, to: res.to ?? plan.to });
    const landed = parked[parked.length - 1];
    ok(
      `${c.bold(plan.repo.name)} ${c.dim(shorten(plan.from))} ${icon.arrow} ${c.dim(path.relative(root, landed.to))}`,
    );
    plain(
      `    ${c.dim(glyph.pending)} second copy — ${c.bold(path.relative(root, plan.keeping) || plan.keeping)} is the one in use`,
    );
    plain(
      `    ${c.dim(glyph.pending)} ${
        plan.holds.length
          ? c.yellow(`holds ${plan.holds.join(' and ')}`)
          : c.dim('fully redundant — every commit is in the copy above')
      }`,
    );
  }

  const done = results.filter((r) => r.ok);
  if (done.length) {
    const state = loadState(root);
    const at = new Date().toISOString();
    saveState(root, {
      ...state,
      adopted: [
        ...(state.adopted ?? []),
        ...done.map((r) => ({ repo: r.plan.repo.name, from: r.plan.from, to: r.plan.to, at })),
      ],
    });
  }

  return { results, parked, warnedAboutClaude };
}

/** Which of the rewritten files are tracked by git, and so now show a diff. */
async function trackedAmong(files) {
  const tracked = [];
  for (const file of files) {
    const { code } = await git(['ls-files', '--error-unmatch', '--', path.basename(file)], {
      cwd: path.dirname(file),
    });
    if (code === 0) tracked.push(file);
  }
  return tracked;
}

/**
 * Report the places that still name the old location and that this tool will
 * not touch, so "nothing was missed" is a statement the developer can check
 * rather than take on trust.
 */
async function reportLeftovers(root, applied) {
  const rewritten = applied.results
    .filter((r) => r.ok)
    .flatMap((r) => r.repairs?.rewritten?.map((h) => h.file) ?? []);

  const tracked = await trackedAmong(rewritten);
  if (tracked.length) {
    plain('');
    warn(
      `${tracked.length} rewritten file${tracked.length > 1 ? 's are' : ' is'} tracked by git — you now have a diff to review:`,
    );
    for (const file of tracked) plain(c.dim(`    ${path.relative(root, file)}`));
  }

  const moved = applied.results.filter((r) => r.ok).map((r) => r.plan);
  const leftovers = moved.flatMap((plan) => unfixablePaths(plan.from));
  if (!leftovers.length) return;

  const needsYou = leftovers.filter((l) => l.actionable);
  const informational = leftovers.filter((l) => !l.actionable);

  if (needsYou.length) {
    plain('');
    heading('Still pointing at the old location — these need you');
    for (const l of needsYou) {
      plain(`  ${c.yellow('!')} ${c.bold(l.what)} ${c.dim(l.detail ?? '')}`);
      plain(`      ${c.dim(l.why)}`);
    }
  }

  if (informational.length) {
    plain('');
    plain(c.dim('  Left alone on purpose:'));
    for (const l of informational) plain(c.dim(`    ${l.what} — ${l.why}`));
  }
}

/**
 * Re-apply the path repair for moves already recorded, moving nothing.
 * The escape hatch for a repair that was reverted underneath us.
 */
export function refixPaths(root) {
  const history = loadState(root).adopted ?? [];
  if (!history.length) return { count: 0 };
  for (const entry of history) {
    plain(`  ${c.bold(entry.repo)} ${c.dim(`${shorten(entry.from)} ${glyph.arrow} ${path.relative(root, entry.to)}`)}`);
    repairPaths(root, { repo: { name: entry.repo }, from: entry.from, to: entry.to });
    for (const l of unfixablePaths(entry.from)) {
      plain(
        `    ${l.actionable ? c.yellow('!') : c.dim('·')} ${l.what} ${c.dim(l.detail ?? '')} ${c.dim(`— ${l.why}`)}`,
      );
    }
  }
  return { count: history.length };
}

/** Fix the absolute paths that pointed at the repo's old home. */
function repairPaths(root, plan) {
  const done = [];

  const sessions = moveClaudeSessions(plan.from, plan.to);
  if (sessions.changed) {
    done.push(
      sessions.merged
        ? `Claude history merged (${sessions.moved} moved, ${sessions.kept} already there)`
        : 'Claude session history and memory',
    );
  } else if (sessions.error) {
    done.push(c.yellow(`Claude history not moved: ${sessions.error}`));
  }

  const settings = rekeyClaudeJson(plan.from, plan.to);
  if (settings.changed) {
    done.push(`~/.claude.json project entry${settings.note ? ` ${c.dim(`(${settings.note})`)}` : ''}`);
  } else if (settings.error) {
    done.push(c.yellow(`~/.claude.json not updated: ${settings.error}`));
  }

  const rewritten = [];
  for (const hit of findConfigHits([root, plan.to], plan.from)) {
    const res = rewriteConfigFile(hit.file, plan.from, plan.to);
    if (res.changed) {
      rewritten.push(hit);
      done.push(`${path.relative(root, hit.file)} ${c.dim(`(${hit.count} path${hit.count > 1 ? 's' : ''})`)}`);
    }
  }

  for (const line of done) plain(`    ${c.dim(glyph.pending)} ${line}`);

  // Some of those config files are committed. Say so — the developer now has a
  // diff to review, and finding it by surprise later is worse.
  return { done, rewritten };
}

// os.homedir(), not process.env.HOME: HOME is unset on Windows, and
// String.replace(undefined, '~') would replace the literal text "undefined".
const shorten = (p) => {
  const home = os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

/**
 * Turn `--from a,b` into absolute paths.
 *
 * Empty segments are dropped BEFORE resolving: `path.resolve('')` is the
 * current directory, so a trailing comma or `--from ""` would otherwise add
 * cwd to the remembered scan paths and quietly hunt for repos to relocate
 * there on every later run.
 */
export function parseFromPaths(from) {
  return (Array.isArray(from) ? from : [from])
    .filter(Boolean)
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(expandHome(s)));
}

export async function run(opts) {
  const { root, manifest, state } = requireWorkspace();

  if (opts['fix-paths']) {
    heading('Repairing paths for repos already adopted');
    const { count } = refixPaths(root);
    if (!count) {
      plain(c.dim('  Nothing recorded — no repo has been adopted in this workspace.'));
    }
    return;
  }

  requireCatalogue(manifest);

  // The whole catalogue, not this machine's selection: a stray checkout is
  // worth moving into place whether or not this machine had signed up for it.
  const repos = selectRepos(manifest, opts, manifest.repos);

  const extra = parseFromPaths(opts.from);

  const remembered = state.scanPaths ?? [];
  const scanRoots = [...new Set([root, ...remembered, ...extra])];

  heading(opts.apply ? 'Adopting existing checkouts' : 'Adopting existing checkouts (dry run)');
  info(
    `searching ${scanRoots.length} location${scanRoots.length > 1 ? 's' : ''}, ` +
      `${repos.length} repo${repos.length > 1 ? 's' : ''} in scope`,
  );
  for (const dir of scanRoots) plain(`    ${c.dim(shorten(dir))}`);

  const { moves, parks, refused, inPlace } = await planFor({
    manifest,
    root,
    repos,
    scanRoots,
    jobs: opts.jobs ?? 8,
  });

  if (inPlace.length) {
    plain('');
    skip(`${inPlace.length} already in the right place`);
  }

  if (!moves.length && !parks.length && !refused.length) {
    plain(`\n${c.dim('Nothing to adopt.')}`);
    return;
  }

  if (moves.length && !opts.apply) {
    plain('');
    for (const p of moves) {
      const mark = p.confidence === 'name' ? c.yellow(glyph.maybe) : c.green(glyph.arrow);
      plain(
        `  ${mark} ${c.bold(p.repo.name)}\n` +
          `      from  ${c.dim(shorten(p.from))}\n` +
          `      to    ${c.dim(path.relative(root, p.to))}`,
      );
    }
    if (moves.some((p) => p.confidence === 'name')) {
      plain('');
      warn(
        `${c.yellow('~')} matched on repo name only — the remote host is not one the catalogue lists.\n` +
          `  Check those remotes before applying.`,
      );
    }
  }

  if (parks.length && !opts.apply) {
    plain('');
    for (const p of parks) {
      plain(
        `  ${c.yellow('⇉')} ${c.bold(p.repo.name)} ${c.dim('— second copy')}\n` +
          `      from  ${c.dim(shorten(p.from))}\n` +
          `      to    ${c.dim(path.relative(root, p.to))}\n` +
          `      keep  ${c.dim(path.relative(root, p.keeping) || p.keeping)}` +
          (p.holds.length ? `\n      ${c.yellow(`holds ${p.holds.join(' and ')}`)}` : ''),
      );
    }
    plain('');
    info(
      c.dim(`Second copies move into ${DUPLICATES_DIR}/ rather than being deleted — everything\n` +
        '    in them is kept, and nothing outside the tree is left behind.'),
    );
  }

  if (refused.length) {
    plain('');
    for (const p of refused) {
      warn(`${c.bold(p.repo.name)} left alone — ${p.reason}\n    ${c.dim(shorten(p.from))}`);
    }
  }

  if (!opts.apply) {
    const bits = [];
    if (moves.length) bits.push(`move ${moves.length} into place`);
    if (parks.length) bits.push(`park ${parks.length} second cop${parks.length === 1 ? 'y' : 'ies'}`);
    plain(`\n${c.dim(bits.length ? `Re-run with --apply to ${bits.join(' and ')}.` : 'Nothing to apply.')}`);
    return;
  }

  if (extra.length) {
    saveState(root, { ...state, scanPaths: [...new Set([...remembered, ...extra])] });
  }

  plain('');
  const applied = await applyMoves(root, moves, parks, manifest);
  const okCount = applied.results.filter((r) => r.ok).length;
  summary({
    ok: okCount + applied.parked.length,
    skipped: inPlace.length,
    failed: applied.results.length - okCount + (parks.length - applied.parked.length),
    okLabel: 'relocated',
  });

  if (applied.parked.length) {
    plain('');
    info(
      `${applied.parked.length} second cop${applied.parked.length === 1 ? 'y' : 'ies'} parked in ` +
        `${c.bold(DUPLICATES_DIR)}/ ${c.dim('— nothing was deleted.')}`,
    );
    plain(c.dim(`  Review them, then remove the folder yourself when you are happy:`));
    plain(c.dim(`    rm -rf ${path.join(root, DUPLICATES_DIR)}`));
  }

  await reportLeftovers(root, applied);

  if (applied.warnedAboutClaude) {
    plain('');
    warn(
      'A Claude Code process is running. It rewrites ~/.claude.json when it exits,\n' +
        '  which can revert the settings fix above. Re-run `talea adopt` after quitting it\n' +
        '  if the project entry looks wrong.',
    );
  }

  if (okCount) {
    plain(`\n${c.dim('To sweep anything this did not cover:')}`);
    for (const r of applied.results.filter((x) => x.ok)) {
      plain(c.dim(`  grep -rl "${r.plan.from}" ${root} ~ 2>/dev/null`));
      break;
    }
  }
}
