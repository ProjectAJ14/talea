// The look of every byte this CLI prints.
//
// Colours, glyphs, spinner frames, box-drawing and the width maths that keeps
// columns aligned once colour codes are in the string. Nothing here knows what
// a repo or a branch is — `log.js` and `live.js` compose these into output, and
// commands use those. Re-skin the whole tool by editing this file alone.
//
// Zero dependencies: raw ANSI escapes, same as the rest of the project.

// ── Gating ─────────────────────────────────────────────────────
// NO_COLOR disables colour. FORCE_COLOR forces it on, which is how the tests
// and `talea ... | less -R` get colour out of a pipe. Otherwise colour follows
// TTY detection, so piping into a file or CI log stays free of escape codes.
export const useColor =
  process.env.NO_COLOR || process.env.TERM === 'dumb'
    ? false
    : process.env.FORCE_COLOR
      ? true
      : !!process.stdout.isTTY;

// 24-bit colour is not universal — Apple Terminal, tmux without `-2` and the
// older Windows consoles all lie about it or drop the escape. COLORTERM is the
// only signal that is actually reliable, so the palette carries a basic-16
// fallback and uses it whenever COLORTERM is not set.
const trueColor = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '');

// ── Phosphor palette ───────────────────────────────────────────
// [24-bit hex, basic-16 SGR code]. The basic code is what a terminal without
// COLORTERM gets; it is deliberately the closest *readable* match rather than
// the closest numerically — `faint` has no bright equivalent, so it falls back
// to grey rather than a green nobody can read on a light background.
const PALETTE = {
  green: ['#39ff14', 92], // hot phosphor — something worked
  aged: ['#1f8a3b', 32], // settled green — a branch, a path, a detail
  faint: ['#0e3b1c', 90], // barely lit — rules and fills
  amber: ['#ffb000', 33], // attention, but not a failure
  red: ['#ff3b30', 31], // failure
  bone: ['#d6dbd6', 37], // plain text that still wants to be lit
};


const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Wrap `str` in one of the palette colours. A no-op when colour is off. */
function tint(name, str) {
  if (!useColor) return String(str);
  const [hex, basic] = PALETTE[name];
  // Both branches close with 39 — "default foreground" — and never with 0.
  // A full reset also clears bold and dim, so a colour nested inside `dim()`
  // would un-dim the rest of the line on a truecolor terminal and not on a
  // basic one: a rendering difference gated on COLORTERM, which is the worst
  // kind to reproduce.
  if (!trueColor) return `\x1b[${basic}m${str}\x1b[39m`;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${str}\x1b[39m`;
}

export const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[22m` : String(s));
export const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[22m` : String(s));

/** The palette, by role. Everything that prints colour goes through here. */
export const paint = {
  ok: (s) => tint('green', s),
  aged: (s) => tint('aged', s),
  faint: (s) => tint('faint', s),
  warn: (s) => tint('amber', s),
  fail: (s) => tint('red', s),
  bone: (s) => tint('bone', s),
  bold,
  dim,
};

// ── Glyphs ─────────────────────────────────────────────────────
// All BMP, all present in the fonts people actually run terminals in. Keep it
// that way — a dingbat that renders as a box wrecks every column after it.
export const glyph = {
  ok: '▣',
  skip: '◌',
  fail: '▤',
  warn: '!',
  pending: '·',
  arrow: '→',
  up: '↑',
  down: '↓',
  maybe: '~',
  groupMark: '◇',
  rule: '─',
  prompt: '==>',
};

/** Frames for work that is genuinely in flight. */
export const spinner = ['◜', '◠', '◝', '◞', '◡', '◟'];

export const box = { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };

// ── Low-level ANSI, for the live block ─────────────────────────
export const ansi = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  cr: '\r',
  up: (n = 1) => (n > 0 ? `\x1b[${n}A` : ''),
};

// ── Width maths ────────────────────────────────────────────────
// Every pad and centre in the tool goes through these. Measuring a coloured
// string with `.length` counts the escape codes and is the classic way to
// break a table one release after it was written.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');
export const visibleWidth = (s) => [...stripAnsi(s)].length;

export function padEndVisible(s, width) {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : String(s);
}

export function padStartVisible(s, width) {
  const pad = width - visibleWidth(s);
  return pad > 0 ? ' '.repeat(pad) + s : String(s);
}

export function centerVisible(s, width) {
  const pad = width - visibleWidth(s);
  if (pad <= 0) return String(s);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + s + ' '.repeat(pad - left);
}

/** Terminal width, clamped to something a human can read across. */
export const columns = () => Math.max(40, Math.min(process.stdout.columns || 80, 120));

/**
 * Cut a string to `width` visible columns, leaving its escape codes intact.
 *
 * The live block redraws by counting the lines it wrote and climbing back up
 * that many. A line wider than the window wraps onto two rows, so the count is
 * short by one and every redraw lands a row lower — the block duplicates itself
 * down the screen. Truncating keeps one line to one row.
 */
export function truncVisible(s, width) {
  const str = String(s);
  if (width <= 0) return '';
  if (visibleWidth(str) <= width) return str;
  let left = width;
  let out = '';
  // eslint-disable-next-line no-control-regex
  for (const part of str.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (!part) continue;
    if (part.startsWith('\x1b[')) {
      out += part;
      continue;
    }
    const chars = [...part];
    if (chars.length <= left) {
      out += part;
      left -= chars.length;
    } else {
      out += chars.slice(0, left).join('');
      left = 0;
    }
  }
  // Cut mid-colour, so close it — otherwise the colour bleeds down the screen.
  return out + (useColor ? '\x1b[0m' : '');
}
