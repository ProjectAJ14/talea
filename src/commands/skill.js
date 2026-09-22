// `talea skill` — put the agent-facing skill in the user's Claude Code.
//
// The skill is a single Markdown file describing how to drive this CLI safely:
// which commands read, which move things, and which two flags must never be
// reached for on somebody's behalf. Installing it at **user scope**
// (`~/.claude/skills/`) rather than in a repo is the point — the developer has
// one workspace across every project, so the agent needs the same instructions
// in all of them.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { c, fail, heading, info, ok, plain, warn } from '../log.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The copy that ships in the package. */
export const source = path.join(here, '..', '..', 'skills', 'talea', 'SKILL.md');

/**
 * Claude Code reads user-scope skills from `~/.claude/skills/<name>/SKILL.md`.
 * `CLAUDE_CONFIG_DIR` is how somebody moves that directory, and honouring it is
 * the difference between installing the skill and installing it somewhere
 * nothing will ever read it.
 */
export const target = () =>
  path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'skills',
    'talea',
    'SKILL.md',
  );

/**
 * The marker that says a file at that path is ours.
 *
 * Somebody may already have their own skill called `talea`. Overwriting it
 * would destroy work this tool has no claim on, so the only file `install`
 * will replace is one carrying this line, and the only file `uninstall` will
 * delete is the same.
 */
const MARK = '<!-- talea-skill:';

export const isOurs = (file) => {
  try {
    return readFileSync(file, 'utf8').includes(MARK);
  } catch {
    return false;
  }
};

export const help = `
${c.bold('talea skill')} — teach your coding agent to drive talea

  ${c.dim('talea skill')}             is it installed, and where
  ${c.dim('talea skill install')}     copy it into ~/.claude/skills/talea/
  ${c.dim('talea skill uninstall')}   take it back out

Installs at ${c.bold('user scope')}, so every project you open gets it — your workspace
spans all of them, and the agent needs the same instructions in each.

The skill is what turns ${c.dim('"where is eklavya?"')} and ${c.dim('"tidy up my repos"')} into the
right talea command, with the guardrails attached: an adopt is always dry-run
first, ${c.dim('--loose')} is never taken on your behalf, and nothing is ever deleted.

It refuses to overwrite a skill called ${c.dim('talea')} that this tool did not write.
Move yours first if you have one.
`;

export function run(opts, positionals = []) {
  const action = positionals[0] ?? 'status';
  const dest = target();

  if (action === 'status') return status(dest);
  if (action === 'install') return install(dest);
  if (action === 'uninstall' || action === 'remove') return uninstall(dest);

  fail(`Unknown: talea skill ${action}`);
  plain(`\n  Try ${c.dim('talea skill install')}, ${c.dim('talea skill uninstall')}, or ${c.dim('talea skill')} on its own.`);
  // `process.exitCode`, not `process.exit()` — the same contract `summary()`
  // uses, and the only one a test can drive without taking the runner down.
  process.exitCode = 1;
}

function status(dest) {
  heading('talea skill');
  if (!existsSync(dest)) {
    warn('Not installed.');
    plain(`\n  ${c.dim('talea skill install')}   put it in ${c.bold(dest)}`);
    return;
  }
  if (!isOurs(dest)) {
    warn(`Something else owns ${c.bold(dest)}.`);
    plain(`\n  It is not a file talea wrote, so talea will not touch it.`);
    return;
  }
  const same = readFileSync(dest, 'utf8') === readFileSync(source, 'utf8');
  ok(`Installed at ${c.bold(dest)}`);
  if (!same) {
    plain(`\n  ${c.yellow('Out of date')} — ${c.dim('talea skill install')} rewrites it from this version.`);
  }
}

function install(dest) {
  heading('talea skill install');

  if (existsSync(dest) && !isOurs(dest)) {
    // Somebody's own skill, under the name we want. Never overwrite it: it is
    // work this tool has no claim on, and there is no undo.
    fail(`There is already a skill called "talea" at ${c.bold(dest)}, and talea did not write it.`);
    plain(`\n  Move it somewhere else first, then run this again. Nothing has been changed.`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  ok(`Installed ${c.bold(dest)}`);
  info(`Restart Claude Code to pick it up — skills are read at session start.`);
  plain(`\n  Then ${c.dim('"where is eklavya?"')} or ${c.dim('"sync my repos"')} reaches the right command on its own.`);
}

function uninstall(dest) {
  heading('talea skill uninstall');

  if (!existsSync(dest)) {
    info('Nothing to remove.');
    return;
  }
  if (!isOurs(dest)) {
    fail(`${c.bold(dest)} is not a file talea wrote — leaving it alone.`);
    process.exitCode = 1;
    return;
  }
  rmSync(dest, { force: true });
  // The directory is ours too, and an empty one left behind shows up in
  // `/skills` as a skill with no file.
  rmSync(path.dirname(dest), { recursive: true, force: true });
  ok(`Removed ${c.bold(dest)}`);
}
