// The picker and the line prompts, driven through a fake stdin.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test, { describe } from 'node:test';

import {
  applyKey,
  applyNames,
  askScope,
  buildTree,
  pickByLine,
  pickOne,
  pickRepos,
  renderRow,
  splitKeys,
  toggle,
  truncate,
} from '../src/prompt.js';
import { stripAnsi } from '../src/theme.js';

const manifest = {
  groups: { work: { title: 'Work things' } },
  repos: [
    { name: 'api', group: 'work' },
    { name: 'web', group: 'work' },
    { name: 'dots', owner: 'me' },
  ],
};

/**
 * Run `fn` with process.stdin replaced by a PassThrough that looks like a
 * terminal, and stdout captured. Returns what `fn` resolved to and what was
 * drawn.
 */
async function withStdin({ tty = true, raw = () => {}, rows, columns } = {}, fn) {
  const input = new PassThrough();
  input.isTTY = tty;
  input.setRawMode = raw;
  const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
  const saved = ['rows', 'columns'].map((k) => [k, Object.getOwnPropertyDescriptor(process.stdout, k)]);
  const write = process.stdout.write;
  const log = console.log;
  let drawn = '';
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  process.stdout.write = (s, ...rest) =>
    typeof s === 'string' ? ((drawn += s), true) : write.call(process.stdout, s, ...rest);
  console.log = (...a) => (drawn += a.join(' ') + '\n');
  try {
    const result = await fn(input);
    return { result, drawn: stripAnsi(drawn) };
  } finally {
    Object.defineProperty(process, 'stdin', stdinDesc);
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(process.stdout, k, d);
      else delete process.stdout[k];
    }
    process.stdout.write = write;
    console.log = log;
  }
}

/** Feed `chunks` one tick apart, so each arrives as its own data event. */
function feed(input, ...chunks) {
  let i = 0;
  const next = () => {
    if (i < chunks.length) {
      input.write(chunks[i++]);
      setImmediate(next);
    }
  };
  setImmediate(next);
}

describe('pickRepos', () => {
  test('toggles, moves and confirms; restores raw mode on the way out', async () => {
    const modes = [];
    const rows = buildTree(manifest, manifest.repos, false);
    const { result, drawn } = await withStdin({ raw: (m) => modes.push(m) }, (input) => {
      const p = pickRepos(rows, { title: 'Pick' });
      // space on api, x is ignored, down to web and tick it, then enter.
      feed(input, ' ', 'x', 'j ', '\r');
      return p;
    });
    assert.deepEqual(result.map((r) => r.name), ['api', 'web']);
    assert.deepEqual(modes, [true, false]);
    assert.match(drawn, /^Pick\n0 of 3 selected/);
    assert.match(drawn, /2 of 3 selected/);
    assert.equal(process.listenerCount('exit'), 0);
  });

  test('q cancels with null', async () => {
    const rows = buildTree(manifest);
    const { result } = await withStdin({}, (input) => {
      const p = pickRepos(rows);
      feed(input, 'q');
      return p;
    });
    assert.equal(result, null);
  });

  test('scrolls a list longer than the window, both ways', async () => {
    const many = { repos: Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, owner: 'o' })) };
    const rows = buildTree(many);
    const { result, drawn } = await withStdin({ rows: 8, columns: 10 }, (input) => {
      const p = pickRepos(rows);
      // End, then Home: past the bottom of the viewport and back above its top.
      feed(input, '\x1b[F', '\x1b[H', '\n');
      return p;
    });
    assert.equal(result.length, 12);
    assert.match(drawn, /❯   ◼ r11/);
    assert.match(drawn, /❯ ◼ o/);
  });

  test('with no repo rows the cursor starts at the top', async () => {
    const { result } = await withStdin({ tty: false }, (input) => {
      const p = pickRepos([]);
      feed(input, '\r');
      return p;
    });
    assert.deepEqual(result, []);
  });

  test('a console that refuses raw mode rejects, so the caller can fall back', async () => {
    await withStdin(
      {
        raw: () => {
          throw new Error('raw mode unsupported');
        },
      },
      () => assert.rejects(pickRepos(buildTree(manifest)), /raw mode unsupported/),
    );
    assert.equal(process.listenerCount('exit'), 0);
  });

  test('a failure to leave raw mode is swallowed while unwinding', async () => {
    const { result } = await withStdin(
      {
        raw: (m) => {
          if (!m) throw new Error('gone');
        },
      },
      (input) => {
        const p = pickRepos(buildTree(manifest));
        feed(input, 'n\r');
        return p;
      },
    );
    assert.deepEqual(result, []);
  });
});

describe('pickOne', () => {
  /** pickOne draws on stderr; capture it the way withStdin captures stdout. */
  async function withStderr(props, fn) {
    const saved = ['rows', 'columns'].map((k) => [k, Object.getOwnPropertyDescriptor(process.stderr, k)]);
    const write = process.stderr.write;
    let drawn = '';
    for (const [k, v] of Object.entries(props)) Object.defineProperty(process.stderr, k, { value: v, configurable: true });
    process.stderr.write = (s, ...rest) =>
      typeof s === 'string' ? ((drawn += s), true) : write.call(process.stderr, s, ...rest);
    try {
      return { ...(await fn()), err: stripAnsi(drawn) };
    } finally {
      process.stderr.write = write;
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(process.stderr, k, d);
        else delete process.stderr[k];
      }
    }
  }
  const labels = Array.from({ length: 8 }, (_, i) => `repo${i}`);

  test('moves both ways, scrolls past the window and back, and resolves the index', async () => {
    const modes = [];
    const { result, err } = await withStderr({ rows: 6, columns: undefined }, () =>
      withStdin({ raw: (m) => modes.push(m) }, (input) => {
        const p = pickOne(labels, { title: 'Go' });
        feed(input, 'jjjj', '\x1b[B\x1bOB', 'kkkkkk', '\x1b[A\x1bOA', 'jj', 'x', '\r');
        return p;
      }),
    );
    assert.equal(result, 2);
    assert.deepEqual(modes, [true, false]);
    assert.match(err, /^Go\n/);
    assert.match(err, /❯ repo6/);
    assert.match(err, /\+\d below/);
    assert.equal(process.listenerCount('exit'), 0);
  });

  test('Ctrl-C, Escape and q cancel; the bottom is a floor', async () => {
    for (const key of ['\u0003', '\x1b', 'q']) {
      const { result } = await withStderr({}, () =>
        withStdin({}, (input) => {
          const p = pickOne(['a'], {});
          feed(input, 'j', key);
          return p;
        }),
      );
      assert.equal(result, null);
    }
  });

  test('a refused raw mode rejects; a failure to leave it is swallowed', async () => {
    const no = () => {
      throw new Error('raw mode unsupported');
    };
    await withStdin({ raw: no }, () => assert.rejects(pickOne(['a']), /raw mode unsupported/));
    assert.equal(process.listenerCount('exit'), 0);
    const { result } = await withStderr({}, () =>
      withStdin({ raw: (m) => m || no() }, (input) => {
        const p = pickOne(['a']);
        feed(input, '\n');
        return p;
      }),
    );
    assert.equal(result, 0);
  });
});

describe('askScope', () => {
  const ask = (answer, counts = { defaults: 3, total: 9, groups: 2 }) =>
    withStdin({ tty: false }, (input) => {
      const p = askScope(counts);
      feed(input, `${answer}\n`);
      return p;
    });

  test('2, c and choose all mean choose', async () => {
    for (const a of ['2', 'c', 'Choose']) assert.equal((await ask(a)).result, 'choose');
  });

  test('anything else is the default set', async () => {
    const { result, drawn } = await ask('');
    assert.equal(result, 'defaults');
    assert.match(drawn, /3 repos/);
    assert.match(drawn, /across 2 owners/);
  });

  test('says repo and owner in the singular for one', async () => {
    const { drawn } = await ask('1', { defaults: 1, total: 1, groups: 1 });
    assert.match(drawn, /1 repo {2}/);
    assert.match(drawn, /across 1 owner$/m);
  });
});

describe('pickByLine', () => {
  const pick = (answer) =>
    withStdin({ tty: false }, (input) => {
      const p = pickByLine(buildTree(manifest, manifest.repos, false));
      feed(input, `${answer}\n`);
      return p;
    });

  test('empty means everything', async () => {
    const { result, drawn } = await pick('');
    assert.equal(result.picked.length, 3);
    assert.match(drawn, /work +2 repos/);
  });

  test('names resolve, and unknown ones are returned', async () => {
    const { result } = await pick('me, nope');
    assert.deepEqual(result.picked.map((r) => r.name), ['dots']);
    assert.deepEqual(result.unknown, ['nope']);
  });
});

describe('the pure parts', () => {
  test('truncate keeps colour codes and stops at an unterminated escape', () => {
    assert.equal(truncate('short', 10), 'short');
    assert.equal(truncate('\x1b[31mabcdef\x1b[39m', 4), '\x1b[31mabc\x1b[0m…');
    assert.equal(truncate('a\x1b[31xyz', 4), 'a\x1b[0m…');
  });

  test('renderRow: group marks for none, some and all; the cursor bolds a repo', () => {
    const rows = buildTree(manifest, manifest.repos, false);
    const line = (i, cur = -1) => stripAnsi(renderRow(rows, i, cur));
    assert.equal(line(0, 0), '❯ ◻ work  Work things');
    toggle(rows, 1);
    assert.equal(line(0), '  ◐ work  Work things');
    toggle(rows, 0);
    assert.equal(line(0), '  ◼ work  Work things');
    assert.equal(line(3), '  ◻ me  ');
    assert.equal(line(1, 1), '❯   ◼ api');
    assert.equal(line(4), '    ◻ dots');
  });

  test('toggle past the end is a no-op', () => {
    const rows = buildTree(manifest);
    assert.equal(toggle(rows, 99), rows);
  });

  test('splitKeys separates CSI, SS3 and plain keys, and keeps a cut-off CSI', () => {
    assert.deepEqual(splitKeys('a\x1b[A\x1bOBk\x1b[5~'), ['a', '\x1b[A', '\x1bOB', 'k', '\x1b[5~']);
    assert.deepEqual(splitKeys('\x1b[12'), ['\x1b[12']);
    assert.deepEqual(splitKeys('\x1b'), ['\x1b']);
  });

  test('applyKey covers every binding', () => {
    const rows = buildTree(manifest, manifest.repos, false);
    const at = (key, cursor = 2) => applyKey(rows, key, cursor, 2);
    for (const k of ['\u0003', '\x1b', 'q']) assert.equal(at(k).action, 'cancel');
    for (const k of ['\r', '\n']) assert.equal(at(k).action, 'confirm');
    assert.equal(at('?').action, 'ignored');
    assert.equal(at('a').action, 'changed');
    assert.ok(rows.filter((r) => r.kind === 'repo').every((r) => r.checked));
    assert.equal(at('n').action, 'changed');
    assert.ok(rows.every((r) => !r.checked));
    for (const k of ['\x1b[A', '\x1bOA', 'k']) assert.equal(at(k).cursor, 1);
    for (const k of ['\x1b[B', '\x1bOB', 'j']) assert.equal(at(k).cursor, 3);
    assert.equal(at('\x1b[5~').cursor, 0);
    assert.equal(at('\x1b[6~').cursor, 4);
    assert.equal(at('\x1b[H').cursor, 0);
    assert.equal(at('\x1b[F').cursor, rows.length - 1);
    assert.equal(at('j', rows.length - 1).cursor, rows.length - 1);
    assert.equal(at('k', 0).cursor, 0);
  });

  test('applyNames matches groups and repos case-insensitively', () => {
    const { picked, unknown } = applyNames(buildTree(manifest), [' WORK ', '', 'x']);
    assert.deepEqual(picked.map((r) => r.name), ['api', 'web']);
    assert.deepEqual(unknown, ['x']);
  });

  test('buildTree takes a predicate, and orders unnamed groups after named ones', () => {
    const rows = buildTree({ repos: manifest.repos }, manifest.repos, (r) => r.name === 'web');
    assert.deepEqual(rows.map((r) => r.label), ['me', 'dots', 'work', 'api', 'web']);
    assert.deepEqual(rows.filter((r) => r.checked).map((r) => r.label), ['web']);
    // A named group with no repos gets no header.
    assert.equal(buildTree({ groups: { empty: {} }, repos: [] }).length, 0);
  });
});
