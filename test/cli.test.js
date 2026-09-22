import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import { routeWords } from '../src/cli.js';
import { currentBranch } from '../src/git.js';

describe('bare words after a command', () => {
  test('are repo names for the commands that act on repos', () => {
    assert.deepEqual(routeWords('sync', ['PiDom'], undefined), { repo: ['PiDom'], words: [] });
    assert.deepEqual(routeWords('status', ['a'], ['b']), { repo: ['b', 'a'], words: [] });
  });

  test('reach the commands that read their own', () => {
    assert.deepEqual(routeWords('where', ['PiDom'], undefined), { repo: undefined, words: ['PiDom'] });
  });

  test('stop a command that takes none, rather than being dropped', () => {
    assert.match(routeWords('doctor', ['x'], undefined).error, /takes no arguments/);
    // adopt: a bare word must not lift the name-only guard that -r lifts.
    assert.match(routeWords('adopt', ['flutter'], undefined).error, /adopt -r flutter/);
  });

  test('no words is no change', () => {
    assert.deepEqual(routeWords('doctor', [], undefined), { repo: undefined, words: [] });
  });
});

test('a repo with no commits still reports its branch, not null', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'talea-unborn-'));
  execFileSync('git', ['init', '-q', '-b', 'trunk', dir]);
  assert.equal(await currentBranch(dir), 'trunk');
});

test('a stray word after a command that takes none exits non-zero', () => {
  const bin = path.join(import.meta.dirname, '..', 'bin', 'talea.js');
  const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
  const r = spawnSync(process.execPath, [bin, 'doctor', 'stray'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
});
