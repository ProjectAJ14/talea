// log.js and live.js: every shape the CLI prints, on a pipe and on a terminal.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import * as log from '../src/log.js';
import { board, task } from '../src/live.js';
import { stripAnsi } from '../src/theme.js';

/** Swap properties on `obj` for the duration of `fn`, restoring the originals. */
async function withProps(obj, props, fn) {
  const saved = Object.fromEntries(Object.keys(props).map((k) => [k, Object.getOwnPropertyDescriptor(obj, k)]));
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(obj, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(obj, k, d);
      else delete obj[k];
    }
  }
}

/** Capture console.log / console.error / stdout / stderr while `fn` runs. */
async function capture(fn) {
  const got = { log: [], error: [], stdout: '', stderr: '' };
  const saved = [console.log, console.error, process.stdout.write, process.stderr.write];
  console.log = (...a) => got.log.push(stripAnsi(a.join(' ')));
  console.error = (...a) => got.error.push(stripAnsi(a.join(' ')));
  // Strings only: the test runner reports to its parent through stdout as
  // Buffers, and swallowing one of those loses a test result.
  const [out, err] = [process.stdout.write, process.stderr.write];
  process.stdout.write = (s, ...rest) =>
    typeof s === 'string' ? ((got.stdout += s), true) : out.call(process.stdout, s, ...rest);
  process.stderr.write = (s, ...rest) =>
    typeof s === 'string' ? ((got.stderr += s), true) : err.call(process.stderr, s, ...rest);
  try {
    got.result = await fn();
  } finally {
    [console.log, console.error, process.stdout.write, process.stderr.write] = saved;
  }
  return got;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('log', () => {
  test('the one-line helpers each print once, fail to stderr', async () => {
    const got = await capture(() => {
      log.plain();
      log.plain('p');
      log.heading('h');
      log.info('i');
      log.ok('o');
      log.skip('s');
      log.warn('w');
      log.fail('f');
      log.group('g', 1);
      log.group('g', 2, 'tree');
    });
    assert.deepEqual(got.log.slice(0, 7), ['', 'p', '\nh', '==> i', '▣ o', '◌ s', '! w']);
    assert.deepEqual(got.error, ['▤ f']);
    assert.match(got.log[7], /◇ g ─+ 1 repo$/);
    assert.match(got.log[8], /◇ g ─+ 2 trees$/);
  });

  test('context joins the pairs it is given and skips the empty ones', async () => {
    const got = await capture(() => log.context([['in', '/w'], null, ['jobs', 4]]));
    assert.deepEqual(got.log, ['▣ in /w   jobs 4']);
  });

  test('table pads to the widest visible cell, with and without a head', async () => {
    const got = await capture(() => {
      log.table([]);
      log.table([['a', log.c.red('bb'), 'x']], ['NAME', 'B', 'C']);
      log.table([['aaa', 'b'], ['c', 'd']], null, { below: [null, 'under'] });
      log.table([[]], null);
    });
    assert.deepEqual(got.log, ['NAME  B   C', 'a     bb  x', 'aaa  b', 'c    d', '     under', '']);
  });

  test('statusLine has one shape per status, with a default note', () => {
    const s = (st, note) => stripAnsi(log.statusLine(st, 'app', note, 4));
    assert.equal(s('ok'), '▣ app');
    assert.equal(s('ok', 'cloned'), '▣ app   cloned');
    assert.equal(s('skip'), '◌ app   skipped');
    assert.equal(s('skip', 'dirty'), '◌ app   dirty');
    assert.equal(s('fail'), '▤ app   failed');
    assert.equal(s('fail', 'boom'), '▤ app   boom');
    assert.equal(s('warn'), '! app');
    assert.equal(s('warn', 'hm'), '! app   hm');
    assert.equal(s('pending'), '· app   queued');
    assert.equal(s('pending', 'next'), '· app   next');
    assert.equal(stripAnsi(log.statusLine('ok', 'a')), '▣ a');
  });

  test('summary: nothing to do, a clean box, and a failure that sets the exit code', async () => {
    const empty = await capture(() => log.summary({}));
    assert.deepEqual(empty.log, ['', 'nothing to do']);

    const clean = await capture(() => log.summary({ ok: 2, okLabel: 'cloned', skipped: 1 }));
    assert.match(clean.log.join('\n'), /R E S U L T S/);
    assert.match(clean.log.join('\n'), /2 cloned {3}◌ 1 skipped/);
    assert.equal(process.exitCode, undefined);

    const bad = await capture(() => log.summary({ failed: 1 }));
    assert.match(bad.log.join('\n'), /1 failed/);
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
  });

  test('verdict: trouble beats partial beats clear', async () => {
    const words = { clear: 'ALL CLEAR', partial: 'PARTIAL', trouble: 'TROUBLE' };
    const say = async (counts, w = words) => (await capture(() => log.verdict(counts, w))).log[1];
    assert.equal(await say({ failed: 1, skipped: 1 }), '▤ TROUBLE');
    assert.equal(await say({ skipped: 1 }), '◌ PARTIAL');
    assert.equal(await say({ skipped: 1 }, { clear: 'ALL CLEAR' }), '▣ ALL CLEAR');
    assert.equal(await say({}), '▣ ALL CLEAR');
  });
});

describe('board, piped', () => {
  test('prints each row once as it settles; failures and notes go to stderr', async () => {
    const got = await capture(() => {
      const b = board(
        [
          { id: 1, group: 'g', label: 'one' },
          { id: 2, group: 'g', label: 'two' },
        ],
        { live: false },
      );
      b.set(1, 'busy');
      b.set(99, 'ok'); // unknown id: ignored
      b.set(1, 'ok', 'cloned');
      b.set(2, 'fail', 'boom');
      b.note(2, 'fatal: nope');
      b.note(1, ''); // empty detail is not a note
      b.note(42, 'orphan'); // a note for an id that has no row keeps the id
      b.stop();
    });
    assert.deepEqual(got.log, ['▣ one  cloned']);
    assert.deepEqual(got.error, ['▤ two  boom', '  two\n    fatal: nope', '  42\n    orphan']);
    assert.equal(got.stdout, '');
  });

  test('defaults to live only on a terminal', async () => {
    await withProps(process.stdout, { isTTY: false }, async () => {
      const got = await capture(() => board([{ id: 1, group: 'g', label: 'a' }]).stop());
      assert.equal(got.stdout, '');
    });
  });
});

describe('board, live', () => {
  const items = (n) => Array.from({ length: n }, (_, i) => ({ id: i, group: `g${i % 2}`, label: `repo${i}` }));

  test('redraws in place, animates, and restores the cursor on stop', async () => {
    await withProps(process.stdout, { rows: 40, columns: 100, isTTY: true }, async () => {
      const got = await capture(async () => {
        const b = board(items(3));
        b.set(0, 'busy');
        b.set(1, 'busy', 'fetching');
        await sleep(100); // one spinner frame
        b.set(0, 'ok');
        b.set(1, 'ok');
        b.set(2, 'skip', 'dirty');
        b.note(2, 'uncommitted work');
        b.stop();
      });
      assert.ok(got.stdout.startsWith('\x1b[?25l'));
      assert.ok(got.stdout.endsWith('\x1b[?25h'));
      const text = stripAnsi(got.stdout);
      assert.match(text, /working …/);
      assert.match(text, /fetching/);
      assert.match(text, /3 of 3 done/);
      assert.deepEqual(got.log, ['  repo2\n    uncommitted work']);
      assert.equal(process.listenerCount('SIGINT'), 0);
    });
  });

  test('too tall for the window: settled rows scroll away above a footer', async () => {
    await withProps(process.stdout, { rows: undefined, columns: undefined }, async () => {
      const got = await capture(() => {
        const b = board(items(30), { live: true });
        b.set(0, 'busy');
        b.set(0, 'ok', 'done');
        b.set(1, 'busy');
        b.stop();
      });
      assert.deepEqual(got.log, ['  ▣ repo0   done']); // padded to repo10
      assert.doesNotMatch(stripAnsi(got.stdout), /◇ g0/);
    });
  });

  test('a resize re-decides whether the block fits', async () => {
    await withProps(process.stdout, { rows: 40 }, async () => {
      const got = await capture(() => {
        const b = board(items(3), { live: true });
        process.stdout.rows = 5;
        process.stdout.emit('resize');
        b.set(0, 'ok');
        b.stop();
      });
      // Now a footer: the settled row is printed on its way out.
      assert.deepEqual(got.log, ['  ▣ repo0']);
    });
  });

  test('Ctrl-C shows the cursor again and exits 130', async () => {
    const exit = process.exit;
    let code;
    process.exit = (c) => {
      code = c;
    };
    try {
      const got = await capture(() => {
        const b = board(items(1), { live: true });
        process.listeners('SIGINT').at(-1)();
        b.stop();
      });
      assert.equal(code, 130);
      assert.match(got.stdout, /\x1b\[\?25h/);
    } finally {
      process.exit = exit;
    }
  });
});

describe('task', () => {
  test('animates beside the label, clears a missing note, fits a narrow window', async () => {
    await withProps(process.stderr, { columns: undefined, isTTY: true }, async () => {
      const got = await capture(() =>
        task('Scanning', async (update) => {
          update('half');
          await sleep(100);
          update();
          await sleep(100);
          return 7;
        }),
      );
      assert.equal(got.result, 7);
      assert.match(stripAnsi(got.stderr), /Scanning {2}half/);
      assert.ok(got.stderr.endsWith('\r\x1b[2K\x1b[?25h'));
    });
  });

  test('defaults to silent when stderr is not a terminal', async () => {
    await withProps(process.stderr, { isTTY: false }, async () => {
      const got = await capture(() => task('Quiet', async (update) => (update('ignored'), 'x')));
      assert.equal(got.result, 'x');
      assert.equal(got.stderr, '');
    });
  });

  test('Ctrl-C clears the line and exits 130', async () => {
    const exit = process.exit;
    let code;
    process.exit = (c) => {
      code = c;
    };
    try {
      const got = await capture(() =>
        task('Waiting', async () => process.listeners('SIGINT').at(-1)(), { live: true }),
      );
      assert.equal(code, 130);
      assert.match(got.stderr, /\x1b\[\?25h/);
    } finally {
      process.exit = exit;
    }
  });
});
