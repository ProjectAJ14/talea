// The live block: rows redrawn in place while `pooled()` works.
//
// Bulk commands used to print a line per repo as each one landed, which under
// `-j 6` meant the order was whichever clone the network finished first. The
// board fixes the order (catalogue order, grouped by folder) and shows what is
// queued, in flight and done while it happens.
//
// There are two renderings and ONE formatter. On a terminal the rows are
// redrawn in place; on a pipe, in CI, or when the board would not fit the
// window, each row prints once as it settles — exactly what this tool printed
// before. Both go through `statusLine()` in log.js, so the animated and the
// plain rendering of a finished repo cannot drift apart.

import {
  ansi,
  glyph,
  groupHeader,
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
 * Start a board over `items` — `{ id, group, label }`, already in the order
 * they should appear.
 *
 * `set(id, status, note)` moves a row; `note(id, text)` attaches detail that
 * belongs under the block rather than in the row (a git error, say); `stop()`
 * freezes the block and prints the detail.
 */
export function board(items, { live = process.stdout.isTTY } = {}) {
  const rows = items.map((it) => ({ ...it, status: 'pending', note: null }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const notes = [];

  const width = Math.min(Math.max(0, ...rows.map((r) => visibleWidth(r.label))), LABEL_MAX);

  // Group headers, rows, a blank line and the counter. When that does not fit
  // the window, `ansi.up()` would address a region that has already scrolled
  // and tear the screen — so settled rows scroll away above a small footer
  // instead of everything being redrawn.
  const groups = [...new Set(rows.map((r) => r.group))];
  const fits = () =>
    live && groups.length + rows.length + 3 <= (process.stdout.rows || 24) - 1;
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

  const rowLine = (r) => {
    if (r.status !== 'busy') return '  ' + statusLine(r.status, r.label, r.note, width);
    const f = paint.warn(spinner[frame % spinner.length]);
    return `  ${f} ${paint.dim(padEndVisible(r.label, width))}  ${paint.dim(r.note ?? 'working …')}`;
  };

  const lines = () => {
    const body = [];
    if (full) {
      for (const g of groups) {
        const mine = rows.filter((r) => r.group === g);
        body.push(groupHeader(g, mine.length));
        for (const r of mine) body.push(rowLine(r));
      }
    } else {
      // Only what is still moving, so the footer stays a fixed handful of lines
      // however many repos are queued behind it.
      for (const r of rows.filter((r) => r.status === 'busy')) body.push(rowLine(r));
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

  /** Print above the live block without tearing it. */
  const emit = (text) => {
    erase();
    console.log(text);
    draw();
  };

  // A window the board once fitted can stop fitting mid-run. Redrawing a block
  // taller than the window makes `ansi.up()` address rows that have already
  // scrolled off, which tears the screen — exactly what `full` exists to avoid —
  // so re-decide on resize and forget the frame that is no longer up there.
  const onResize = () => {
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

      if (live) {
        // In the rolling footer a finished row leaves the block, so print it on
        // the way out — otherwise the run would keep no record of it at all.
        if (!full && SETTLED.has(status)) emit('  ' + statusLine(status, r.label, note, width));
        return;
      }

      // Piped: one line per row, as it settles. Failures keep going to stderr,
      // which is where every script and CI job already looks for them.
      if (!SETTLED.has(status)) return;
      const line = statusLine(status, r.label, note, width);
      if (status === 'fail') console.error(line);
      else console.log(line);
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
      if (live) {
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
