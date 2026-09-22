// The agent-facing skill, and the one rule that makes installing it safe:
// a file called `talea` that this tool did not write is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isOurs, run, source, target } from '../src/commands/skill.js';

/** Run `fn` with CLAUDE_CONFIG_DIR pointed at a scratch directory. */
function inScratch(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'talea-skill-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn(dir);
  } finally {
    console.log = log;
    console.error = error;
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the skill ships with the package and declares itself', () => {
  const text = readFileSync(source, 'utf8');
  // The frontmatter `name` is what Claude Code registers, and the description
  // is the only thing it reads when deciding whether to load the skill at all.
  assert.match(text, /^---\nname: talea\ndescription: "/);
  // Every command the skill tells an agent to run has to exist.
  for (const cmd of ['where', 'status', 'adopt', 'sync', 'select', 'manifest', 'exec']) {
    assert.match(text, new RegExp(`talea ${cmd}`), `the skill never mentions ${cmd}`);
  }
});

test('CLAUDE_CONFIG_DIR decides where it lands', () => {
  inScratch((dir) => {
    assert.equal(target(), path.join(dir, 'skills', 'talea', 'SKILL.md'));
  });
});

test('install writes the packaged copy, and says so again on a second run', () => {
  inScratch((dir) => {
    const dest = path.join(dir, 'skills', 'talea', 'SKILL.md');
    run({}, ['install']);
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(source, 'utf8'));
    assert.ok(isOurs(dest));

    // Idempotent: reinstalling over our own copy is how an upgrade lands.
    run({}, ['install']);
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(source, 'utf8'));
  });
});

test('a skill called talea that we did not write is never overwritten', () => {
  // Somebody's own `~/.claude/skills/talea/` is months of their work and there
  // is no undo. Refusing is the whole safety story for this command.
  inScratch((dir) => {
    const dest = path.join(dir, 'skills', 'talea', 'SKILL.md');
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, '---\nname: talea\n---\n\nmine, not yours\n');

    // `run` reports failure through process.exitCode, so put the real one back
    // or one refusal here marks the whole test FILE as failed.
    const saved = process.exitCode;
    process.exitCode = 0;
    let code;
    try {
      run({}, ['install']);
      code = process.exitCode;
    } finally {
      process.exitCode = saved;
    }

    assert.equal(code, 1, 'a refusal has to be visible to a script');
    assert.match(readFileSync(dest, 'utf8'), /mine, not yours/);
  });
});

test('uninstall removes our copy and the directory it was alone in', () => {
  inScratch((dir) => {
    const dest = path.join(dir, 'skills', 'talea', 'SKILL.md');
    run({}, ['install']);
    run({}, ['uninstall']);
    assert.equal(existsSync(dest), false);
    // An empty directory left behind reads as a skill with no file.
    assert.equal(existsSync(path.dirname(dest)), false);
  });
});
