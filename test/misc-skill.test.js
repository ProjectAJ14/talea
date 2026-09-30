// `talea skill` status and the refusal paths. CLAUDE_CONFIG_DIR always points
// into a scratch folder — nothing here may touch the real ~/.claude.

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TALEA_NO_UPDATE_CHECK = '1';
const { isOurs, run, source, target } = await import('../src/commands/skill.js');

let dir;
let out;
const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, log: console.log, error: console.error };
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'talea-skill-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  out = [];
  console.log = console.error = (s = '') => out.push(String(s));
});
afterEach(() => {
  console.log = saved.log;
  console.error = saved.error;
  if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const text = () => out.join('\n');

test('without CLAUDE_CONFIG_DIR it lands under the home directory', () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(target(), path.join(os.homedir(), '.claude', 'skills', 'talea', 'SKILL.md'));
});

test('isOurs is false for a file that cannot be read', () => {
  assert.equal(isOurs(path.join(dir, 'missing.md')), false);
});

test('status: not installed, installed, out of date, and somebody else\'s', () => {
  run({});
  assert.match(text(), /Not installed/);

  run({}, ['install']);
  out = [];
  run({}, ['status']);
  assert.match(text(), /Installed at/);
  assert.doesNotMatch(text(), /Out of date/);

  writeFileSync(target(), readFileSync(source, 'utf8') + '\nextra\n');
  out = [];
  run({});
  assert.match(text(), /Out of date/);

  writeFileSync(target(), '# my own skill\n');
  out = [];
  run({});
  assert.match(text(), /Something else owns/);
  assert.equal(process.exitCode ?? 0, 0);
});

test('an unknown action fails loudly', () => {
  run({}, ['instal']);
  assert.match(text(), /Unknown: talea skill instal/);
  assert.equal(process.exitCode, 1);
});

test('uninstall: nothing there, somebody else\'s, and ours via the remove alias', () => {
  run({}, ['uninstall']);
  assert.match(text(), /Nothing to remove/);
  assert.equal(process.exitCode ?? 0, 0);

  mkdirSync(path.dirname(target()), { recursive: true });
  writeFileSync(target(), '# my own skill\n');
  run({}, ['uninstall']);
  assert.equal(process.exitCode, 1);
  assert.equal(readFileSync(target(), 'utf8'), '# my own skill\n');

  process.exitCode = undefined;
  rmSync(target());
  run({}, ['install']);
  run({}, ['remove']);
  assert.equal(existsSync(path.dirname(target())), false);
  assert.equal(process.exitCode ?? 0, 0);
});
