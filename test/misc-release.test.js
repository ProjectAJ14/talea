// The CI half of scripts/release.mjs, run against a throwaway git repo in a
// scratch folder. It only ever reads git here; nothing is tagged, pushed or
// published, and the real package.json and CHANGELOG.md are never written.

import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A scratch home, so no global git config (signing, hooks) reaches the commits.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = home;
const { main, prependSection } = await import('../scripts/release.mjs');

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-release-')));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let n = 0;
/** A repo holding package.json and CHANGELOG.md, one commit per message. */
function makeRepo(...messages) {
  const dir = path.join(tmp, `r${n++}`);
  git(['init', '-q', '-b', 'main', dir], tmp);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 't'], dir);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version: '0.4.0' }));
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [0.4.0] - 2026-01-01\n\n- old\n');
  messages.forEach((m, i) => {
    writeFileSync(path.join(dir, `f${i}.txt`), m);
    git(['add', '-A'], dir);
    git(['commit', '-qm', m], dir);
  });
  return dir;
}

let out;
const saved = {};
beforeEach(() => {
  out = [];
  Object.assign(saved, { log: console.log, cwd: process.cwd(), argv: process.argv, gho: process.env.GITHUB_OUTPUT });
  console.log = (s = '') => out.push(String(s));
  // CI sets this for the test step itself; never append to that one.
  delete process.env.GITHUB_OUTPUT;
});
afterEach(() => {
  console.log = saved.log;
  process.chdir(saved.cwd);
  process.argv = saved.argv;
  if (saved.gho === undefined) delete process.env.GITHUB_OUTPUT;
  else process.env.GITHUB_OUTPUT = saved.gho;
});

const root = (dir) => pathToFileURL(dir + path.sep);
const pkg = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));

test('with no tag, every commit counts and a feat cuts a minor', () => {
  const dir = makeRepo('chore: init', 'feat(sync): faster');
  process.chdir(dir);
  process.argv = ['node', 'release.mjs'];
  const outFile = path.join(tmp, 'gh-output-1');
  process.env.GITHUB_OUTPUT = outFile;

  main(root(dir));

  assert.equal(pkg(dir).version, '0.5.0');
  const changelog = readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[0\.5\.0\][^]*\*\*sync\*\*: faster[^]*## \[0\.4\.0\]/);
  assert.match(readFileSync(path.join(dir, '.release-notes.md'), 'utf8'), /faster/);
  assert.equal(readFileSync(outFile, 'utf8'), 'release=true\nversion=0.5.0\n');
  assert.match(out.join('\n'), /pkg 0\.5\.0 \(minor, 2 commit\(s\)\)/);
});

test('since the last tag, docs alone release nothing and write nothing', () => {
  const dir = makeRepo('feat: old');
  git(['tag', 'v0.4.0'], dir);
  writeFileSync(path.join(dir, 'd.txt'), 'd');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'docs: readme'], dir);
  process.chdir(dir);
  process.argv = ['node', 'release.mjs', 'auto'];

  main(root(dir));

  assert.equal(pkg(dir).version, '0.4.0');
  assert.equal(existsSync(path.join(dir, '.release-notes.md')), false);
  assert.match(out.join('\n'), /nothing to release — 1 commit\(s\) since v0\.4\.0/);
  assert.match(out.join('\n'), /release=false/);
});

test('a breaking change below 1.0.0 takes the minor and gets its own section', () => {
  const dir = makeRepo('feat(adopt)!: stop guessing');
  process.chdir(dir);
  process.argv = ['node', 'release.mjs'];
  main(root(dir));
  assert.equal(pkg(dir).version, '0.5.0');
  assert.match(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), /### Breaking\n- stop guessing/);
});

test('a forced bump wins over the commits', () => {
  const dir = makeRepo('docs: only docs');
  process.chdir(dir);
  process.argv = ['node', 'release.mjs', 'patch'];
  main(root(dir));
  assert.equal(pkg(dir).version, '0.4.1');
  assert.match(out.join('\n'), /pkg 0\.4\.1 \(patch, 1 commit\(s\)\)/);
});

test('run as a script, it releases from the working directory', () => {
  // Only docs since the start, so the real package.json is read and nothing
  // is written — which is also what makes it safe to run from a test.
  const dir = makeRepo('docs: only docs');
  const script = new URL('../scripts/release.mjs', import.meta.url);
  const pkgFile = new URL('../package.json', import.meta.url);
  const before = readFileSync(pkgFile, 'utf8');
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  const printed = execFileSync(process.execPath, [fileURLToPath(script)], {
    cwd: dir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(printed, /nothing to release — 1 commit\(s\) since the start/);
  assert.equal(readFileSync(pkgFile, 'utf8'), before);
});

test('the first release goes under a changelog that has no sections yet', () => {
  assert.equal(prependSection('# Changelog\n\n', '## [0.1.0]\n'), '# Changelog\n\n## [0.1.0]\n');
});
