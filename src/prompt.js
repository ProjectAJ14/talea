// Interactive selection. No dependencies: raw stdin plus the same ANSI codes
// log.js already uses.
//
// The state machine (buildTree / toggle / groupState / selectedRepos) is pure
// and separate from the rendering, so the selection logic is testable without
// a terminal — which is the only reason it can be trusted at all.

import readline from 'node:readline/promises';

import { c, glyph } from './log.js';
import { repoGroup } from './config.js';

const ESC = '\u001b';
const CTRL_C = '\u0003';

/**
 * A flat list of rows: each group followed by its repos. Flat rather than a
 * nested structure because the thing being rendered is a list, and the thing
 * being navigated is a list.
 *
 * `preselected` is either a boolean for every row, or a predicate — which is
 * how the picker opens with your default set already ticked and everything
 * else visible but off.
 */
export function buildTree(manifest, repos = manifest.repos, preselected = true) {
  const tick = typeof preselected === 'function' ? preselected : () => preselected;

  const byGroup = new Map();
  for (const repo of repos) {
    const group = repoGroup(repo);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(repo);
  }

  // The catalogue's group order first, then any group the catalogue does not
  // name — a repo's owner stands in for a group it was never given, so a
  // freshly discovered catalogue has a sensible tree with no curation at all.
  const order = [
    ...Object.keys(manifest.groups ?? {}),
    ...[...byGroup.keys()].filter((g) => !(g in (manifest.groups ?? {}))).sort(),
  ];

  const rows = [];
  for (const group of order) {
    const members = byGroup.get(group);
    if (!members?.length) continue;
    rows.push({ kind: 'group', group, label: group, title: manifest.groups?.[group]?.title });
    for (const repo of members) {
      rows.push({ kind: 'repo', group, label: repo.name, repo, checked: Boolean(tick(repo)) });
    }
  }
  return rows;
}

/** 'all' | 'some' | 'none' for a group, derived from its repos — never stored. */
export function groupState(rows, group) {
  const members = rows.filter((r) => r.kind === 'repo' && r.group === group);
  const on = members.filter((r) => r.checked).length;
  if (on === 0) return 'none';
  return on === members.length ? 'all' : 'some';
}

/**
 * Toggle row `i`, in place.
 *
 * A group row toggles every repo under it — checking `V1` takes all of V1,
 * which is what selecting a folder is expected to mean. A partially selected
 * group fills up rather than emptying, because that is the direction someone
 * pressing space on it almost always wants.
 */
export function toggle(rows, i) {
  const row = rows[i];
  if (!row) return rows;

  if (row.kind === 'repo') {
    row.checked = !row.checked;
    return rows;
  }

  const next = groupState(rows, row.group) !== 'all';
  for (const r of rows) {
    if (r.kind === 'repo' && r.group === row.group) r.checked = next;
  }
  return rows;
}

export function setAll(rows, checked) {
  for (const r of rows) if (r.kind === 'repo') r.checked = checked;
  return rows;
}

export const selectedRepos = (rows) =>
  rows.filter((r) => r.kind === 'repo' && r.checked).map((r) => r.repo);

const GROUP_MARK = { all: '◼', some: '◐', none: '◻' };

/** Visible length, ignoring ANSI colour codes. */
const visible = (s) => s.replace(/\u001b\[[0-9;]*m/g, '').length;

/**
 * Cut a line to `width` visible characters, keeping colour codes intact.
 * Written by hand rather than by slicing the string, because a naive slice cuts
 * an escape sequence in half and bleeds colour across the rest of the screen.
 */
export function truncate(line, width) {
  if (visible(line) <= width) return line;
  let out = '';
  let shown = 0;
  let i = 0;
  while (i < line.length && shown < width - 1) {
    if (line[i] === '\u001b') {
      const end = line.indexOf('m', i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += line[i];
    shown++;
    i++;
  }
  return `${out}\u001b[0m…`;
}

/** One rendered line. Exported so a test can assert what the user sees. */
export function renderRow(rows, i, cursor) {
  const row = rows[i];
  const pointer = i === cursor ? c.cyan('❯') : ' ';

  if (row.kind === 'group') {
    const state = groupState(rows, row.group);
    const box = state === 'none' ? c.grey(GROUP_MARK.none) : c.cyan(GROUP_MARK[state]);
    return `${pointer} ${box} ${c.bold(row.label)}  ${c.dim(row.title ?? '')}`;
  }

  const box = row.checked ? c.green('◼') : c.grey('◻');
  return `${pointer}   ${box} ${i === cursor ? c.bold(row.label) : row.label}`;
}

/**
 * Split one stdin chunk into individual keypresses.
 *
 * stdin delivers whatever arrived since the last read, so fast typing, key
 * repeat and paste all produce several keys in a single event — and an escape
 * sequence like an arrow key is itself multiple bytes. Comparing a whole chunk
 * against one key silently drops everything the user did, which is how this
 * was first found: a pty test that fed five keys at once and hung forever.
 */
export function splitKeys(chunk) {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === ESC && chunk[i + 1] === '[') {
      // CSI sequence: ESC [ ... final byte in @-~
      let j = i + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++;
      keys.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else if (chunk[i] === ESC && chunk[i + 1] === 'O') {
      // Application cursor mode: ESC O A. Some terminals send arrows this way.
      keys.push(chunk.slice(i, i + 3));
      i += 3;
    } else {
      keys.push(chunk[i]);
      i++;
    }
  }
  return keys;
}

/** What a key did, so the caller knows whether to repaint or stop reading. */
export function applyKey(rows, key, cursor, pageSize) {
  const clamp = (n) => Math.max(0, Math.min(rows.length - 1, n));

  switch (key) {
    case CTRL_C:
    case ESC:
    case 'q':
      return { action: 'cancel', cursor };
    case '\r':
    case '\n':
      return { action: 'confirm', cursor };
    case ' ':
      toggle(rows, cursor);
      return { action: 'changed', cursor };
    case 'a':
      setAll(rows, true);
      return { action: 'changed', cursor };
    case 'n':
      setAll(rows, false);
      return { action: 'changed', cursor };
    case `${ESC}[A`:
    case `${ESC}OA`:
    case 'k':
      return { action: 'changed', cursor: clamp(cursor - 1) };
    case `${ESC}[B`:
    case `${ESC}OB`:
    case 'j':
      return { action: 'changed', cursor: clamp(cursor + 1) };
    case `${ESC}[5~`:
      return { action: 'changed', cursor: clamp(cursor - pageSize) };
    case `${ESC}[6~`:
      return { action: 'changed', cursor: clamp(cursor + pageSize) };
    case `${ESC}[H`:
      return { action: 'changed', cursor: 0 };
    case `${ESC}[F`:
      return { action: 'changed', cursor: rows.length - 1 };
    default:
      return { action: 'ignored', cursor };
  }
}

/**
 * The checkbox list. Resolves to the selected repos, or null if cancelled.
 * The caller must have already confirmed this is a TTY.
 */
export function pickRepos(rows, { title = 'Select what to clone' } = {}) {
  return new Promise((resolve, reject) => {
    const out = process.stdout;
    let cursor = rows.findIndex((r) => r.kind === 'repo');
    if (cursor < 0) cursor = 0;
    let top = 0;
    let painted = 0;
    let done = false;

    // Leave room for the title, the counter and the key hints.
    const viewport = () => Math.max(5, (out.rows || 24) - 6);

    const draw = () => {
      const height = viewport();
      if (cursor < top) top = cursor;
      if (cursor >= top + height) top = cursor - height + 1;

      const total = rows.filter((r) => r.kind === 'repo').length;
      const lines = [
        c.bold(title),
        c.dim(`${selectedRepos(rows).length} of ${total} selected`),
        '',
      ];
      for (let i = top; i < Math.min(rows.length, top + height); i++) {
        lines.push(renderRow(rows, i, cursor));
      }
      const more = rows.length - (top + height);
      lines.push('');
      lines.push(
        c.dim(`${glyph.up}${glyph.down} move  space toggle  a all  n none  enter ok  q cancel`) +
          (more > 0 ? c.cyan(`   +${more} below`) : ''),
      );

      // Repaint in place: back up over what was drawn last time and clear down.
      // Every line is clamped to the terminal width first — a line that wraps
      // occupies two rows, `painted` would undercount, and the list smears.
      const width = Math.max(20, out.columns || 80);
      const clamped = lines.map((line) => truncate(line, width));
      if (painted) out.write(`${ESC}[${painted}A${ESC}[0J`);
      out.write(clamped.join('\n') + '\n');
      painted = clamped.length;
    };

    // A process that exits while raw mode is on leaves the shell with no echo
    // and no line editing, which looks like a hung terminal.
    const restore = () => {
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {
        // Nothing useful to do while unwinding.
      }
    };
    process.once('exit', restore);

    const finish = (value) => {
      done = true;
      process.stdin.off('data', onData);
      process.off('exit', restore);
      restore();
      process.stdin.pause();
      if (painted) out.write(`${ESC}[${painted}A${ESC}[0J`);
      resolve(value);
    };

    const onData = (chunk) => {
      let dirty = false;
      for (const key of splitKeys(chunk)) {
        if (done) return;
        const res = applyKey(rows, key, cursor, viewport());
        cursor = res.cursor;
        if (res.action === 'cancel') return finish(null);
        if (res.action === 'confirm') return finish(selectedRepos(rows));
        if (res.action === 'changed') dirty = true;
      }
      if (dirty) draw();
    };

    // Some Windows console hosts refuse raw mode outright. Surface that so the
    // caller can fall back to typed names, rather than dying mid-prompt.
    try {
      process.stdin.setRawMode(true);
    } catch (err) {
      process.off('exit', restore);
      reject(err);
      return;
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    draw();
  });
}

/**
 * The opening question. Cloning everything is the default because a workspace
 * with repos missing is one where cross-repo search quietly lies to you — but
 * disk is disk, so choosing is one keypress away.
 */
export async function askScope({ defaults, total, groups }) {
  console.log(`\n${c.bold('This machine has not chosen what it keeps.')}`);
  console.log(
    `  ${c.cyan('1')}  the default set — ${defaults} repo${defaults === 1 ? '' : 's'}  ${c.dim('(default)')}`,
  );
  console.log(
    `  ${c.cyan('2')}  choose from all ${total} across ${groups} owner${groups === 1 ? '' : 's'}`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n${c.dim('[1/2]')} `)).trim();
  rl.close();
  return answer === '2' || /^c(hoose)?$/i.test(answer) ? 'choose' : 'defaults';
}

/**
 * Selection without raw mode: a numbered list read as one line. Used when the
 * terminal cannot do raw mode — a real possibility on Windows consoles, which
 * this project has not been able to test.
 */
export async function pickByLine(rows) {
  const groups = [...new Set(rows.map((r) => r.group))];
  console.log(`\n${c.bold('Groups')}`);
  for (const g of groups) {
    const members = rows.filter((r) => r.kind === 'repo' && r.group === g);
    console.log(`  ${c.cyan(g.padEnd(10))} ${c.dim(`${members.length} repos`)}`);
  }
  console.log(c.dim('\nEnter group and/or repo names, comma separated. Empty = everything.'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\n> ')).trim();
  rl.close();

  if (!answer) return { picked: selectedRepos(setAll(rows, true)), unknown: [] };
  return applyNames(rows, answer.split(','));
}

/**
 * Resolve typed group/repo names against the tree. Unknown names are returned
 * rather than ignored — a typo that silently clones nothing is the failure
 * mode this project treats as worse than stopping.
 */
export function applyNames(rows, names) {
  const wanted = new Set(names.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  setAll(rows, false);

  for (const r of rows) {
    if (r.kind !== 'repo') continue;
    if (wanted.has(r.group.toLowerCase()) || wanted.has(r.label.toLowerCase())) r.checked = true;
  }

  const known = new Set();
  for (const r of rows) {
    known.add(r.group.toLowerCase());
    if (r.kind === 'repo') known.add(r.label.toLowerCase());
  }
  return {
    picked: selectedRepos(rows),
    unknown: [...wanted].filter((w) => !known.has(w)),
  };
}
