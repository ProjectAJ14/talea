// Terminal output. Every colour, glyph and width comes from `theme.js` — this
// module only composes them into the shapes commands actually print, so
// re-skinning the whole CLI is a change to one file and nothing else.
//
// `log.js` also owns the process exit code: `summary()` is what makes a partial
// failure visible to a script, so every bulk command must end with it.

import {
  ansi,
  bold,
  box,
  centerVisible,
  columns,
  dim,
  glyph,
  paint,
  padEndVisible,
  spinner,
  stripAnsi,
  truncVisible,
  useColor,
  visibleWidth,
} from './theme.js';

export { ansi, glyph, padEndVisible, paint, spinner, truncVisible, useColor, visibleWidth };

/**
 * Named colours, kept because every command's `help` string and most inline
 * detail text is written against them. They are roles in the phosphor palette
 * now rather than raw ANSI, so re-skinning `theme.js` moves them all at once.
 */
export const c = {
  bold,
  dim,
  red: paint.fail,
  green: paint.ok,
  yellow: paint.warn,
  blue: paint.aged,
  cyan: paint.aged,
  grey: paint.faint,
};

export const icon = {
  ok: paint.ok(glyph.ok),
  skip: paint.warn(glyph.skip),
  fail: paint.fail(glyph.fail),
  warn: paint.warn(glyph.warn),
  arrow: paint.aged(glyph.arrow),
};

export const plain = (s = '') => console.log(s);
export const heading = (s) => console.log(`\n${bold(s)}`);
export const info = (s) => console.log(`${paint.aged(glyph.prompt)} ${s}`);
export const ok = (s) => console.log(`${icon.ok} ${s}`);
export const skip = (s) => console.log(`${icon.skip} ${dim(s)}`);
export const warn = (s) => console.log(`${icon.warn} ${s}`);
export const fail = (s) => console.error(`${icon.fail} ${s}`);

/**
 * A group header: the name, a rule filling the line, and a count on the right.
 * Used by the live block and anywhere else output is bucketed by folder group.
 */
export function groupHeader(name, count, noun = 'repo') {
  const left = `${glyph.groupMark} ${name} `;
  const right = ` ${count} ${noun}${count === 1 ? '' : 's'}`;
  const width = Math.min(columns() - 2, 58);
  const fill = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
  return paint.aged(left) + paint.faint(glyph.rule.repeat(fill)) + dim(right);
}

export const group = (name, count, noun) => console.log(groupHeader(name, count, noun));

/**
 * The context strip under a heading — where the command is working, on which
 * environment, how wide. `parts` is a list of [label, value] pairs.
 */
export function context(parts) {
  const bits = parts
    .filter(Boolean)
    .map(([k, v]) => `${dim(k)} ${v}`)
    .join(dim('   '));
  console.log(`${paint.ok(glyph.ok)} ${bits}`);
}

/** Strip ANSI so padding math stays correct on coloured cells. */
const visibleLength = (s) => stripAnsi(s).length;

/**
 * Render an aligned table. `rows` is an array of arrays; `head` is optional.
 * Columns are left-aligned and padded to the widest visible cell.
 */
export function table(rows, head) {
  const all = head ? [head, ...rows] : rows;
  if (all.length === 0) return;
  const widths = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  const render = (row) =>
    row
      .map((cell, i) =>
        i === row.length - 1
          ? String(cell)
          : String(cell) + ' '.repeat(widths[i] - visibleLength(cell)),
      )
      .join('  ')
      .trimEnd();

  if (head) console.log(dim(render(head)));
  for (const row of rows) console.log(render(row));
}

/**
 * One settled row: a glyph, an aligned name, and a note.
 *
 * Both output paths go through this one formatter — the live block freezes its
 * rows with it, and the piped path prints them with it — so the animated and
 * the plain rendering of a finished repo can never drift apart.
 */
export function statusLine(status, label, note, width = 0) {
  const name = padEndVisible(label, width);
  switch (status) {
    case 'ok':
      return `${paint.ok(glyph.ok)} ${paint.ok(name)}  ${note ?? ''}`.trimEnd();
    case 'skip':
      return `${paint.warn(glyph.skip)} ${paint.warn(name)}  ${dim(note ?? 'skipped')}`;
    case 'fail':
      return `${paint.fail(glyph.fail)} ${paint.fail(name)}  ${dim(note ?? 'failed')}`;
    case 'warn':
      return `${paint.warn(glyph.warn)} ${bold(name)}  ${dim(note ?? '')}`.trimEnd();
    default:
      return `${dim(glyph.pending)} ${dim(name)}  ${dim(note ?? 'queued')}`;
  }
}

// ── The results box ────────────────────────────────────────────

const BOX_INNER = 46;

const boxRow = (content) =>
  paint.aged(box.v) + centerVisible(content, BOX_INNER) + paint.aged(box.v);

/**
 * The closing counters, e.g. "12 cloned, 3 skipped, 1 failed", in a box.
 *
 * Also sets a non-zero exit code when anything failed. Bulk commands print
 * per-repo errors and keep going, so without this a script or pipeline would
 * read a partial failure as complete success.
 */
export function summary(counts) {
  const parts = [];
  if (counts.ok) parts.push(paint.ok(`${glyph.ok} ${counts.ok} ${counts.okLabel}`));
  if (counts.skipped) parts.push(paint.warn(`${glyph.skip} ${counts.skipped} skipped`));
  if (counts.failed) parts.push(paint.fail(`${glyph.fail} ${counts.failed} failed`));

  console.log('');
  if (parts.length === 0) {
    console.log(dim('nothing to do'));
    return;
  }

  console.log(paint.aged(box.tl + box.h.repeat(BOX_INNER) + box.tr));
  console.log(boxRow(bold('R E S U L T S')));
  console.log(boxRow(parts.join('   ')));
  console.log(paint.aged(box.bl + box.h.repeat(BOX_INNER) + box.br));

  if (counts.failed) process.exitCode = 1;
}

/**
 * The closing line under the box: what the run means, in one sentence.
 *
 * Three states, not two. `clear` is an absolute claim — "every repo is level
 * with origin" — and anything skipped falsifies it, so a run with skips gets
 * `partial` instead. Reporting an all-skipped run as ALL CLEAR is the kind of
 * lie that only shows up when somebody trusts it.
 */
export function verdict(counts, { clear, partial, trouble }) {
  console.log('');
  if (counts.failed) {
    console.log(`${paint.warn(glyph.fail)} ${bold(paint.warn(trouble))}`);
    return;
  }
  if (counts.skipped && partial) {
    console.log(`${paint.warn(glyph.skip)} ${bold(paint.warn(partial))}`);
    return;
  }
  console.log(`${paint.ok(glyph.ok)} ${bold(paint.ok(clear))}`);
}
