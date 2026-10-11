// The live block: rows redrawn in place while `pooled()` works.
//
// Bulk commands used to print a line per repo as each one landed, which under
// `-j 6` meant the order was whichever clone the network finished first. The
// board draws the folder tree exactly as `talea tree` does — same branches,
// same sort, from the same folderTree() — and shows what is queued, in flight
// and done while it happens.
//
// There are two renderings and ONE formatter. On a terminal the tree is
// redrawn in place; on a pipe, in CI, or when it would not fit the window, its
// lines print once each, top to bottom, as soon as every row above them has
// settled — so the scrollback ends up holding the same tree. Rows go through
// `statusLine()` in log.js, so the animated and the plain rendering of a
// finished repo cannot drift apart.

import {
  ansi,
  folderTree,
  glyph,
  padEndVisible,
  paint,
  spinner,
  statusLine,
  truncVisible,
  visibleWidth,
} from './log.js';

const FRAME_MS = 80;
const SETTLED = new Set(['ok', 'skip', 'fail', 'warn']);
const LABEL_MAX = 46;

const out = (s) => process.stdout.write(s);

/**
 * Start a board over `items` — `{ id, group, name, label }`, where `group` is
 * the folder path the repo lives under, split on `/` so work/api and work/web
 * share one work/, and `name` its own folder's name, as `talea tree` shows it
 * (`repoPlace()` gives both). `label` names it in the notes under the block,
 * and stands in for a missing `name`.
 *
 * `set(id, status, note)` moves a row; `note(id, text)` attaches detail that
 * belongs under the block rather than in the row (a git error, say); `stop()`
 * freezes the block and prints the detail.
 */
export function board(items, { live = process.stdout.isTTY } = {}) {
  const rows = items.map((it) => ({
    ...it,
    path: it.group.split('/'),
    name: it.name ?? it.label,
    status: 'pending',
    note: null,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const notes = [];

  // Top-level folders sit flush left: the workspace root is in the heading
  // above the board, so there is no root line for them to hang from.
  const tree = folderTree(rows, { rooted: false });
  // The name column is as wide as the deepest branch plus the longest name, so
  // the notes line up down the whole tree, not just within one folder.
  const width = Math.max(
    0,
    ...tree
      .filter((l) => l.item)
      .map((l) => visibleWidth(l.prefix) + Math.min(visibleWidth(l.item.name), LABEL_MAX)),
  );

  // How far down the tree has been printed for good — piped, above the rolling
  // footer, or in a full frame a resize left behind. A line goes out only once
  // every row above it has settled, so the printed tree is never out of order.
  let printed = 0;

  // The tree, a blank line and the counter. When that does not fit the window,
  // `ansi.up()` would address a region that has already scrolled and tear the
  // screen — so the tree prints line by line above a small footer instead of
  // being redrawn.
  const fits = () => live && tree.length - printed + 2 <= (process.stdout.rows || 24) - 1;
  let full = fits();


  let frame = 0;
  let drawn = 0;
  let timer = null;

  const counter = () => {
    const done = rows.filter((r) => SETTLED.has(r.status)).length;
    return done < rows.length
      ? `${paint.dim('working …')}  ${paint.ok(String(done))}${paint.dim(`/${rows.length}`)}`
      : `${paint.ok(glyph.arrow)} ${paint.bold(`${done} of ${rows.length} done`)}`;
  };

  const rowLine = (r, prefix, w = width - visibleWidth(prefix)) => {
    const p = paint.dim(prefix);
    if (r.status !== 'busy') return p + statusLine(r.status, r.name, r.note, w);
    const f = paint.warn(spinner[frame % spinner.length]);
    return `${p}${f} ${paint.dim(padEndVisible(r.name, w))}  ${paint.dim(r.note ?? 'working …')}`;
  };

  const treeLine = (l) => (l.item ? rowLine(l.item, l.prefix) : paint.dim(l.prefix) + paint.bold(`${l.folder}/`));

  /** The tree lines that can go out for good now — or all of them, at the end. */
  const ready = (all = false) => {
    const start = printed;
    while (printed < tree.length) {
      const { item } = tree[printed];
      if (item && !all && !SETTLED.has(item.status)) break;
      printed++;
    }
    return tree.slice(start, printed);
  };

  const lines = () => {
    const body = [];
    if (full) {
      // Not the lines already out for good: after a stretch in the rolling
      // footer they are on screen above, and drawing them again repeats them.
      for (const l of tree.slice(printed)) body.push(treeLine(l));
    } else {
      // Only what is still moving, so the footer stays a fixed handful of lines
      // however many repos are queued behind it.
      for (const r of rows.filter((r) => r.status === 'busy')) body.push(rowLine(r, '  ', width));
    }
    body.push('');
    body.push(counter());
    return body;
  };

  const erase = () => {
    if (!drawn) return;
    let s = ansi.up(drawn) + ansi.cr;
    s += (ansi.clearLine + '\n').repeat(drawn);
    out(s + ansi.up(drawn));
    drawn = 0;
  };

  // One line, one row. A line wider than the window wraps, and then `drawn` —
  // a count of lines, not of rows — climbs back too few rows and the next frame
  // is drawn below the last one instead of over it. That is how the block ends
  // up repeating itself down the screen with half-cleared remnants in between.
  // The last column is left empty: a line filling the row exactly leaves some
  // terminals in a deferred-wrap state that the following newline then spends.
  const fitRow = (l) => truncVisible(l, Math.max(1, (process.stdout.columns || 80) - 1));

  const draw = () => {
    const body = lines();
    let s = (drawn ? ansi.up(drawn) : '') + ansi.cr;
    for (const l of body) s += ansi.clearLine + fitRow(l) + '\n';
    // The previous block may have been taller — clear what is left of it, then
    // put the cursor back under the new one.
    const extra = Math.max(0, drawn - body.length);
    s += (ansi.clearLine + '\n').repeat(extra) + ansi.up(extra);
    out(s);
    drawn = body.length;
  };

  // Piped: the tree, a line at a time. Failures keep going to stderr, which is
  // where every script and CI job already looks for them.
  const printPiped = (lines) => {
    for (const l of lines) {
      if (l.item?.status === 'fail') console.error(treeLine(l));
      else console.log(treeLine(l));
    }
  };

  /** Print tree lines above the live block without tearing it. */
  const emitTree = (lines) => {
    if (!lines.length) return;
    erase();
    console.log(lines.map(treeLine).join('\n'));
    draw();
  };

  // A window the board once fitted can stop fitting mid-run. Redrawing a block
  // taller than the window makes `ansi.up()` address rows that have already
  // scrolled off, which tears the screen — exactly what `full` exists to avoid —
  // so re-decide on resize and forget the frame that is no longer up there.
  // A forgotten full frame stays on screen, so its settled lines count as
  // printed: the next block — rolling or full — starts below them instead of
  // repeating them from the top (found in review).
  const onResize = () => {
    if (full) ready();
    full = fits();
    drawn = 0;
  };

  if (live) {
    out(ansi.hideCursor);
    process.on('exit', restoreCursor);
    process.on('SIGINT', onSigint);
    process.stdout.on('resize', onResize);
    draw();
    timer = setInterval(() => {
      frame++;
      draw();
    }, FRAME_MS);
    timer.unref?.();
  }

  return {
    /** Move a row. `status` is pending | busy | ok | skip | fail | warn. */
    set(id, status, note = null) {
      const r = byId.get(id);
      if (!r) return;
      r.status = status;
      r.note = note;

      if (!SETTLED.has(status)) return;
      if (!live) return printPiped(ready());
      // In the rolling footer a finished row leaves the block, so its part of
      // the tree is printed above it — otherwise the run would keep no record
      // of it at all. A full block already shows it.
      if (!full) emitTree(ready());
    },

    /** Detail that belongs under the block rather than in the row. */
    note(id, text) {
      if (text) notes.push([id, text]);
    },

    /** Freeze the block, then print whatever detail was collected. */
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!live) printPiped(ready(true));
      else {
        if (!full) emitTree(ready(true));
        draw();
        restoreCursor();
        process.off('exit', restoreCursor);
        process.off('SIGINT', onSigint);
        process.stdout.off('resize', onResize);
      }
      for (const [id, text] of notes) {
        const label = byId.get(id)?.label ?? id;
        const detail = `  ${paint.dim(label)}\n    ${paint.dim(text)}`;
        if (live) console.log(detail);
        else console.error(detail);
      }
    },
  };
}

const restoreCursor = () => out(ansi.showCursor);

// A hidden cursor outlives the process, so Ctrl-C has to put it back. Node runs
// no exit handlers for a default SIGINT, which is why this is its own listener.
function onSigint() {
  restoreCursor();
  process.exit(130);
}

/**
 * One line that says what is happening while `fn` works — the loading state
 * for anything slower than a blink that is not a per-repo board: a GitHub
 * call, a filesystem scan, a pass over every worktree. `fn` gets
 * `update(note)` to show progress beside the label.
 *
 * It draws on stderr, and only when stderr is a terminal, so `talea where` and
 * every piped stdout stay byte-for-byte what they were. It leaves nothing
 * behind: the line is cleared either way, because what the command prints next
 * is the loaded state, and an error thrown by `fn` reaches the caller untouched
 * to be reported as the error state.
 */
export async function task(label, fn, { live = process.stderr.isTTY } = {}) {
  if (!live) return fn(() => {});
  const err = (s) => process.stderr.write(s);
  let note = '';
  let frame = 0;
  const draw = () => {
    const f = paint.warn(spinner[frame++ % spinner.length]);
    const line = `${f} ${label}${note ? `  ${paint.dim(note)}` : ''}`;
    err(ansi.cr + ansi.clearLine + truncVisible(line, Math.max(1, (process.stderr.columns || 80) - 1)));
  };
  const show = () => err(ansi.showCursor);
  const onInt = () => {
    err(ansi.cr + ansi.clearLine);
    show();
    process.exit(130);
  };
  err(ansi.hideCursor);
  process.on('exit', show);
  process.on('SIGINT', onInt);
  draw();
  const timer = setInterval(draw, FRAME_MS);
  timer.unref?.();
  try {
    return await fn((n) => {
      note = n ?? '';
    });
  } finally {
    clearInterval(timer);
    err(ansi.cr + ansi.clearLine);
    show();
    process.off('exit', show);
    process.off('SIGINT', onInt);
  }
}
