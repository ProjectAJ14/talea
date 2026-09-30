// The loading line: what `task()` promises every slow command.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { task } from '../src/live.js';
import { stripAnsi } from '../src/theme.js';

/** Capture stderr for the duration of `fn`. */
async function stderrOf(fn) {
  const chunks = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => (chunks.push(String(s)), true);
  try {
    return { result: await fn(), text: chunks.join('') };
  } catch (err) {
    return { error: err, text: chunks.join('') };
  } finally {
    process.stderr.write = write;
  }
}

describe('task', () => {
  test('on a terminal: shows the label while working, then clears it', async () => {
    const { result, text } = await stderrOf(() =>
      task('Checking worktrees', async (update) => {
        update('1/2  app');
        return 42;
      }, { live: true }),
    );
    assert.equal(result, 42);
    assert.match(stripAnsi(text), /Checking worktrees/);
    // Ends on a cleared line with the cursor back, leaving nothing behind.
    assert.ok(text.endsWith('\r\x1b[2K\x1b[?25h'), JSON.stringify(text.slice(-20)));
  });

  test('an error reaches the caller, and the line is still cleared', async () => {
    const { error, text } = await stderrOf(() =>
      task('Asking GitHub', async () => {
        throw new Error('401');
      }, { live: true }),
    );
    assert.equal(error.message, '401');
    assert.ok(text.endsWith('\x1b[?25h'));
  });

  test('piped: prints nothing at all', async () => {
    const { result, text } = await stderrOf(() => task('Reading', async () => 'ok', { live: false }));
    assert.equal(result, 'ok');
    assert.equal(text, '');
  });
});
