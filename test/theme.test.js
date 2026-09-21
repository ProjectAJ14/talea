// The look layer: width maths that has to ignore colour, and the live block's
// promise that its piped rendering is the same one it freezes on a terminal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  centerVisible,
  glyph,
  padEndVisible,
  stripAnsi,
  truncVisible,
  visibleWidth,
} from '../src/theme.js';
import { statusLine, verdict } from '../src/log.js';
import { board } from '../src/live.js';
import { defaultJobs } from '../src/git.js';

// A coloured cell, written out rather than built from the palette, so the test
// still means something if the palette changes.
const RED = '\x1b[38;2;255;59;48m';
const OFF = '\x1b[0m';
const coloured = `${RED}platform-api${OFF}`;

test('width maths measures what is on screen, not the escape codes', () => {
  assert.equal(stripAnsi(coloured), 'platform-api');
  assert.equal(visibleWidth(coloured), 12);
  assert.notEqual(coloured.length, 12);

  // The padding is what keeps a table aligned once a cell is coloured — the
  // classic way this breaks is `.length`, which would pad to a negative here.
  assert.equal(visibleWidth(padEndVisible(coloured, 20)), 20);
  assert.equal(visibleWidth(centerVisible(coloured, 20)), 20);

  // Already wider than the target: left alone, never truncated.
  assert.equal(padEndVisible('abcdefgh', 4), 'abcdefgh');
  assert.equal(centerVisible('abcdefgh', 4), 'abcdefgh');
});

test('every glyph is one column wide', () => {
  // A two-column glyph shifts every cell after it and there is no padding maths
  // that recovers from it. This is the guard on adding a new one.
  for (const [name, g] of Object.entries(glyph)) {
    if (name === 'prompt') continue; // the one deliberate multi-character token
    assert.equal(visibleWidth(g), 1, `${name} is not one column`);
  }
});

/** Run `fn` with console.log/error captured. */
function captured(fn) {
  const out = [];
  const log = console.log;
  const error = console.error;
  console.log = (s = '') => out.push(['out', String(s)]);
  console.error = (s = '') => out.push(['err', String(s)]);
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return out;
}

const ITEMS = [
  { id: 'alpha', group: 'CORE', label: 'alpha' },
  { id: 'beta', group: 'CORE', label: 'beta' },
];

test('off a terminal the board prints one line per row, as it settles', () => {
  const lines = captured(() => {
    const view = board(ITEMS, { live: false });
    view.set('alpha', 'busy', 'cloning …');
    view.set('beta', 'busy', 'cloning …');
    view.set('alpha', 'ok', 'qa');
    view.set('beta', 'fail', 'clone failed');
    view.note('beta', 'fatal: could not read from remote');
    view.stop();
  });

  // Nothing is drawn for work in flight — a pipe has no cursor to redraw with,
  // and a spinner frame per repo per 80ms is not something a CI log should hold.
  assert.equal(lines.filter(([, l]) => l.includes('cloning')).length, 0);

  const settled = lines.filter(([, l]) => /alpha|beta/.test(l));
  assert.equal(settled.length, 3); // two rows plus beta's detail

  // Failures keep going to stderr, which is where scripts and CI already look.
  assert.deepEqual(
    settled.map(([stream]) => stream),
    ['out', 'err', 'err'],
  );
  assert.match(lines.at(-1)[1], /could not read from remote/);
});

test('the board freezes a row with the same formatter the pipe prints', () => {
  // Two renderings, one formatter. If these ever diverge, a repo reads one way
  // on a terminal and another in a log, and the two paths have to be debugged
  // separately — which is exactly what this module exists to avoid.
  const piped = captured(() => {
    const view = board(ITEMS, { live: false });
    view.set('alpha', 'skip', 'origin is gone');
    view.stop();
  });

  assert.equal(piped[0][1], statusLine('skip', 'alpha', 'origin is gone', 5));
});

test('an unknown row id is ignored rather than throwing', () => {
  // A worker that reports on a repo the board was not given must not take the
  // whole run down with it.
  const lines = captured(() => {
    const view = board(ITEMS, { live: false });
    view.set('nobody', 'ok', 'somewhere');
    view.stop();
  });
  assert.equal(lines.length, 0);
});

test('the default job count stays inside its bounds', () => {
  // Network-bound work: more than a dozen simultaneous SSH sessions gets you
  // throttled, and fewer than six is slower than what this replaced.
  const jobs = defaultJobs();
  assert.ok(Number.isInteger(jobs), 'not a whole number');
  assert.ok(jobs >= 6 && jobs <= 12, `out of bounds: ${jobs}`);
});

test('a note survives the row it was attached to failing', () => {
  // This is what makes `env --stash` safe to report. The stash is announced the
  // moment it happens, as a note; if the checkout afterwards fails, the row
  // ends as a failure and the note must STILL reach the developer — their
  // uncommitted work is in a stash and nothing else on screen says so.
  const lines = captured(() => {
    const view = board(ITEMS, { live: false });
    view.note('alpha', 'stashed local changes — recover with `git stash pop`');
    view.set('alpha', 'fail', 'checkout failed');
    view.stop();
  });

  assert.match(lines.map(([, l]) => l).join('\n'), /stashed local changes/);
});

test('a run with nothing but skips does not claim ALL CLEAR', () => {
  // `clear` is an absolute claim — "every repo is level with origin" — and a
  // skip falsifies it. Saying it anyway is a lie that only surfaces when
  // somebody trusts it.
  const words = { clear: 'ALL CLEAR', partial: '3 fetched only', trouble: '2 failed' };

  const clean = captured(() => verdict({ ok: 5, skipped: 0, failed: 0 }, words));
  assert.match(clean.at(-1)[1], /ALL CLEAR/);

  const skipped = captured(() => verdict({ ok: 0, skipped: 3, failed: 0 }, words));
  assert.doesNotMatch(skipped.at(-1)[1], /ALL CLEAR/);
  assert.match(skipped.at(-1)[1], /fetched only/);

  // A failure still outranks a skip.
  const failed = captured(() => verdict({ ok: 0, skipped: 3, failed: 2 }, words));
  assert.match(failed.at(-1)[1], /2 failed/);
});

// ── Colour gating ──────────────────────────────────────────────
// `useColor` and `trueColor` are decided once, at module evaluation, from the
// environment. A fresh copy per case is the only way to exercise both branches;
// the query string defeats the ESM module cache.

let bust = 0;
async function themeWith(env) {
  const saved = {};
  for (const k of ['NO_COLOR', 'FORCE_COLOR', 'COLORTERM', 'TERM']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await import(`../src/theme.js?case=${bust++}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('NO_COLOR strips every escape but keeps the glyphs', async () => {
  const t = await themeWith({ NO_COLOR: '1', FORCE_COLOR: '1' });
  assert.equal(t.useColor, false, 'NO_COLOR must win over FORCE_COLOR');
  assert.equal(t.paint.ok('done'), 'done');
  assert.equal(t.bold('x'), 'x');
  assert.equal(t.dim('x'), 'x');
  // The glyph is content, not decoration — a log with colour stripped still has
  // to say which repos failed.
  assert.equal(t.glyph.ok, '▣');
});

test('TERM=dumb is treated like NO_COLOR', async () => {
  const t = await themeWith({ TERM: 'dumb' });
  assert.equal(t.useColor, false);
  assert.equal(t.paint.fail('x'), 'x');
});

test('FORCE_COLOR turns colour on through a pipe', async () => {
  // node --test gives us no TTY, so this is the only way the suite (or
  // `talea ... | less -R`) sees colour at all.
  const t = await themeWith({ FORCE_COLOR: '1' });
  assert.equal(t.useColor, true);
  assert.notEqual(t.paint.ok('x'), 'x');
});

test('truecolor is gated on COLORTERM, with a basic-16 fallback', async () => {
  const full = await themeWith({ FORCE_COLOR: '1', COLORTERM: 'truecolor' });
  const basic = await themeWith({ FORCE_COLOR: '1', COLORTERM: undefined });

  assert.match(full.paint.ok('x'), /\x1b\[38;2;\d+;\d+;\d+m/, 'expected 24-bit');
  assert.doesNotMatch(basic.paint.ok('x'), /38;2;/, 'must not emit 24-bit without COLORTERM');
  assert.match(basic.paint.ok('x'), /\x1b\[\d\dm/, 'expected a basic SGR code');

  // Same visible text either way — only the escapes differ.
  assert.equal(full.stripAnsi(full.paint.ok('x')), 'x');
  assert.equal(basic.stripAnsi(basic.paint.ok('x')), 'x');
});

test('both colour paths close with the same reset, so nesting composes', async () => {
  // A full reset (\x1b[0m) also clears bold and dim, so a colour nested inside
  // dim() would un-dim the rest of the line on one terminal and not the other —
  // a rendering difference gated on an env var, which is the worst kind to
  // reproduce.
  for (const colorterm of ['truecolor', undefined]) {
    const t = await themeWith({ FORCE_COLOR: '1', COLORTERM: colorterm });
    assert.ok(t.paint.ok('x').endsWith('\x1b[39m'), `COLORTERM=${colorterm} used a different reset`);
    assert.doesNotMatch(t.paint.ok('x'), /\x1b\[0m/, `COLORTERM=${colorterm} emitted a full reset`);
  }
});

// ── The exit code ──────────────────────────────────────────────
// `summary()` is the only thing that makes a partial failure visible to a
// script, and nothing tested it directly before.

// `summary()` sets process.exitCode as a side effect — that IS the contract —
// so every test that calls it has to put the real one back, or one assertion
// about a failed run marks the whole test FILE as failed. That is not
// hypothetical: it happened while writing these.

/** Run `fn` with console captured and the real process.exitCode restored after. */
function isolatingExitCode(fn) {
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    return { lines: captured(fn), exitCode: process.exitCode };
  } finally {
    process.exitCode = saved;
  }
}

const exitCodeOf = (fn) => isolatingExitCode(fn).exitCode;
const linesOf = (fn) =>
  isolatingExitCode(fn)
    .lines.map(([, l]) => l)
    .join('\n');

test('summary sets a non-zero exit code if and only if something failed', async () => {
  const { summary } = await import('../src/log.js');

  assert.equal(exitCodeOf(() => summary({ ok: 3, skipped: 0, failed: 0, okLabel: 'cloned' })), 0);
  // A skip is a deliberate outcome, not a failure — `talea sync` over a
  // workspace somebody is working in must still exit 0 or nobody can script it.
  assert.equal(exitCodeOf(() => summary({ ok: 0, skipped: 5, failed: 0, okLabel: 'cloned' })), 0);
  assert.equal(exitCodeOf(() => summary({ ok: 0, skipped: 0, failed: 0, okLabel: 'cloned' })), 0);
  assert.equal(exitCodeOf(() => summary({ ok: 3, skipped: 1, failed: 1, okLabel: 'cloned' })), 1);
});

test('summary prints the counts a script greps for, inside the box', async () => {
  const { summary } = await import('../src/log.js');
  const lines = linesOf(() => summary({ ok: 12, skipped: 3, failed: 1, okLabel: 'cloned' }));

  assert.match(lines, /12 cloned/);
  assert.match(lines, /3 skipped/);
  assert.match(lines, /1 failed/);
  assert.match(lines, /R E S U L T S/);
});

test('an empty run says so instead of drawing an empty box', async () => {
  const { summary } = await import('../src/log.js');
  const lines = linesOf(() => summary({ ok: 0, skipped: 0, failed: 0, okLabel: 'cloned' }));
  assert.match(lines, /nothing to do/);
  assert.doesNotMatch(lines, /R E S U L T S/);
});

// ── The live block's cursor arithmetic ─────────────────────────
// Only the piped path was covered. This drives the real redraw and checks the
// one invariant that matters: the cursor never climbs above the top of the
// block. Going higher addresses rows that have already scrolled, which is the
// tearing this module's `full` guard exists to prevent.

/** Drive a live board against a fake terminal of `rows` height. */
function onFakeTerminal(rows, itemCount, script) {
  const chunks = [];
  const realWrite = process.stdout.write;
  const descriptors = {
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
  };
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  process.stdout.write = (s) => {
    chunks.push(String(s));
    return true;
  };

  const items = Array.from({ length: itemCount }, (_, i) => ({
    id: `r${i}`,
    group: i % 2 ? 'EDGE' : 'CORE',
    label: `repo-${i}`,
  }));

  let logged = [];
  try {
    logged = captured(() => script(board(items, { live: true }), items));
  } finally {
    process.stdout.write = realWrite;
    for (const [k, d] of Object.entries(descriptors)) {
      if (d) Object.defineProperty(process.stdout, k, d);
      else delete process.stdout[k];
    }
  }
  // The block is written straight to stdout; rows leaving the rolling footer go
  // through console.log. Both land on stdout in production, in this order.
  return { out: chunks.join(''), logged: logged.map(([, l]) => l).join('\n') };
}

/**
 * Replay the escape stream as a terminal would and return how far the cursor
 * ever climbed above the block's starting line. Anything above 0 is a tear.
 */
function highestClimb(out) {
  let pos = 0;
  let worst = 0;
  for (const token of out.match(/\x1b\[\d+A|\n/g) ?? []) {
    if (token === '\n') pos += 1;
    else pos -= Number(token.slice(2, -1));
    worst = Math.min(worst, pos);
  }
  return Math.abs(worst); // Math.abs, not -worst: assert.equal(-0, 0) is false.
}

test('the live board never moves the cursor above the block it drew', () => {
  // Full mode: 6 repos in a 40-row window, every row settling one at a time.
  const { out } = onFakeTerminal(40, 6, (view, items) => {
    for (const it of items) view.set(it.id, 'busy', 'cloning …');
    for (const it of items) view.set(it.id, 'ok', 'qa');
    view.stop();
  });

  assert.equal(highestClimb(out), 0, 'cursor climbed above the block');
  assert.ok(out.includes('\x1b[?25l') && out.includes('\x1b[?25h'), 'cursor not hidden/restored');
  // Full mode really was taken: group headers are only drawn there.
  assert.match(out, /◇ CORE/);
});

test('the rolling footer is used when the board would not fit the window', () => {
  // 20 repos in a 10-row window: settled rows must scroll away above a small
  // footer rather than the whole board being redrawn.
  const { out, logged } = onFakeTerminal(10, 20, (view, items) => {
    for (const it of items.slice(0, 3)) view.set(it.id, 'busy', 'cloning …');
    for (const it of items.slice(0, 3)) view.set(it.id, 'ok', 'qa');
    view.stop();
  });

  assert.equal(highestClimb(out), 0, 'cursor climbed above the block');
  assert.doesNotMatch(out, /◇ CORE/, 'group headers belong to full mode only');
  // Each settled repo is still recorded on its way out of the footer — without
  // this the run would finish having shown no trace of most of its work.
  for (const name of ['repo-0', 'repo-1', 'repo-2']) assert.match(logged, new RegExp(name));
});

test('a frame shorter than the last one clears what it no longer covers', () => {
  // Three rows in flight collapsing to none is the shrink case: without the
  // clear, the tail of the taller frame stays on screen as garbage.
  const { out } = onFakeTerminal(10, 20, (view, items) => {
    for (const it of items.slice(0, 3)) view.set(it.id, 'busy', 'cloning …');
    view.set('r0', 'ok', 'qa');
    view.set('r1', 'ok', 'qa');
    view.set('r2', 'ok', 'qa');
    view.stop();
  });

  assert.equal(highestClimb(out), 0);
  // Every redraw blanks the line it writes, so nothing is ever left behind.
  const drawn = (out.match(/\x1b\[2K/g) ?? []).length;
  assert.ok(drawn > 0, 'no line was ever cleared');
});

test('the board stops listening once it is done', () => {
  // The board hooks process-level events. Leaving them attached across a long
  // run leaks a listener per command and eventually trips Node's warning.
  const before = {
    exit: process.listenerCount('exit'),
    sigint: process.listenerCount('SIGINT'),
    resize: process.stdout.listenerCount('resize'),
  };

  onFakeTerminal(40, 4, (view, items) => {
    for (const it of items) view.set(it.id, 'ok', 'qa');
    view.stop();
  });

  assert.equal(process.listenerCount('exit'), before.exit);
  assert.equal(process.listenerCount('SIGINT'), before.sigint);
  assert.equal(process.stdout.listenerCount('resize'), before.resize);
});

test('the live board never writes a line wider than the window', () => {
  // A line that wraps costs a screen row the block does not count, so
  // `ansi.up(drawn)` lands one row low and the next frame is drawn under the
  // last instead of over it — the block repeats itself down the screen. The
  // labels and notes here are long enough to wrap an 80-column window.
  const { out } = onFakeTerminal(40, 4, (view, items) => {
    for (const it of items) {
      view.set(it.id, 'busy', 'fetching feature/a-very-long-descriptive-branch-name-from-a-ticket (not main)');
    }
    view.set(items[0].id, 'ok', 'feature/a-very-long-descriptive-branch-name-from-a-ticket (not main) up to date');
    view.stop();
  });

  for (const row of stripAnsi(out).split('\n')) {
    assert.ok(row.length <= 79, `line of ${row.length} columns wraps an 80-column window`);
  }
});

test('truncation counts columns, not escape codes, and closes the colour', () => {
  assert.equal(truncVisible('abcdef', 10), 'abcdef');
  assert.equal(visibleWidth(truncVisible(coloured, 5)), 5);
  // Cut mid-colour: the reset has to go back on or it bleeds down the screen.
  assert.match(truncVisible(coloured, 5), /\x1b\[0m$/);
});
