// `talea shell-init`: the shell function that lets `talea cd` and `tcd` move
// the shell, which no program can do for the shell that started it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import { run } from '../src/commands/shell-init.js';

async function capture(fn) {
  const out = [];
  const err = [];
  const saved = [process.stdout.write, process.stderr.write, process.exit];
  process.stdout.write = (s) => (out.push(s), true);
  process.stderr.write = (s) => (err.push(s), true);
  process.exit = (code) => {
    throw Object.assign(new Error('exit'), { exitCode: code });
  };
  let code;
  try {
    await fn();
  } catch (e) {
    if (!('exitCode' in e)) throw e;
    code = e.exitCode;
  } finally {
    [process.stdout.write, process.stderr.write, process.exit] = saved;
  }
  return { out: out.join(''), err: err.join(''), code };
}

describe('shell-init', () => {
  test('names a shell, or reads $SHELL', async () => {
    assert.match((await capture(() => run({}, ['zsh']))).out, /^talea\(\) \{[\s\S]*tcd\(\)/);
    assert.match((await capture(() => run({}, ['fish']))).out, /^function talea[\s\S]*function tcd/);
    const shell = process.env.SHELL;
    try {
      process.env.SHELL = '/usr/local/bin/bash';
      assert.match((await capture(() => run({}))).out, /^talea\(\) \{/);
      delete process.env.SHELL;
      const none = await capture(() => run({}));
      assert.equal(none.code, 1);
      assert.match(none.err, /No shell-init for ""/);
    } finally {
      if (shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = shell;
    }
  });

  test('an unknown shell exits non-zero with nothing on stdout', async () => {
    const { out, err, code } = await capture(() => run({}, ['tcsh']));
    assert.equal(out, '');
    assert.match(err, /talea knows zsh, bash and fish/);
    assert.equal(code, 1);
  });

  // Runs the printed function in a real bash against a stand-in `talea`.
  test('in bash: tcd and talea cd move the shell, a failure does not, the rest pass through', { skip: process.platform === 'win32' }, async () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-shell-')));
    try {
      const fake = path.join(tmp, 'talea');
      writeFileSync(
        fake,
        `#!/bin/sh\nif [ "$1" = where ] && [ "$2" = ek ]; then echo "${tmp}"; elif [ "$1" = where ]; then exit 1; else echo "real $*"; fi\n`,
      );
      chmodSync(fake, 0o755);
      const { out: script } = await capture(() => run({}, ['bash']));
      const sh = (line) =>
        execFileSync('bash', ['-c', `${script}\ncd /\n${line}\npwd`], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH}` },
        }).trim();
      assert.equal(sh('tcd ek'), tmp);
      assert.equal(sh('talea cd ek'), tmp);
      assert.equal(sh('tcd typo'), '/');
      assert.equal(sh('talea sync -r x'), `real sync -r x\n/`);
      assert.equal(sh('talea cd --help'), `real cd --help\n/`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
