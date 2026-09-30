import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import { autoUpdateOutcome } from '../src/update.js';

describe('the last background update', () => {
  test('reads as updated once this copy is newer than the one that started it', () => {
    assert.equal(autoUpdateOutcome({ from: '0.7.0', to: '0.8.0' }, '0.8.0'), 'updated');
    // A manual upgrade past the target still counts.
    assert.equal(autoUpdateOutcome({ from: '0.7.0', to: '0.8.0' }, '0.9.0'), 'updated');
  });

  test('reads as failed only when the background run recorded an exit code', () => {
    assert.equal(autoUpdateOutcome({ from: '0.7.0', to: '0.8.0', failed: 1 }, '0.7.0'), 'failed');
    // Still running: nothing to say yet.
    assert.equal(autoUpdateOutcome({ from: '0.7.0', to: '0.8.0' }, '0.7.0'), null);
    assert.equal(autoUpdateOutcome(undefined, '0.7.0'), null);
  });
});

function runWithState(state) {
  const bin = path.join(import.meta.dirname, '..', 'bin', 'talea.js');
  const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
  mkdirSync(path.join(home, '.talea'));
  writeFileSync(path.join(home, '.talea', 'state.json'), JSON.stringify(state));
  const r = spawnSync(process.execPath, [bin, 'doctor'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  return { ...r, state: JSON.parse(readFileSync(path.join(home, '.talea', 'state.json'), 'utf8')) };
}

describe('update notices', () => {
  // `cd $(talea where)` reads stdout; a notice there is a directory that does not exist.
  test('go to stderr, never stdout', () => {
    const r = runWithState({ lastCheck: Date.now(), latestSeen: '999.0.0' });
    assert.match(r.stderr, /Update available/);
    assert.doesNotMatch(r.stdout, /Update available/);
  });

  test('announce a finished background update once, then forget it', () => {
    const r = runWithState({ lastCheck: Date.now(), autoUpdate: { from: '0.0.1', to: '0.0.2', at: Date.now() } });
    assert.match(r.stderr, /Updated 0\.0\.1/);
    assert.equal(r.state.autoUpdate, undefined);
  });

  test('announce a failed one with where to look', () => {
    const r = runWithState({ lastCheck: Date.now(), autoUpdate: { from: '999.0.0', to: '999.0.1', at: Date.now(), failed: 243 } });
    assert.match(r.stderr, /Automatic update failed.*243.*update\.log/s);
    assert.equal(r.state.autoUpdate, undefined);
  });
});
