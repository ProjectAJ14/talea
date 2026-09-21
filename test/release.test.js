// What the pipeline decides to release, and what it writes down.
//
// The release runs unattended on every push to main, so the only thing standing
// between a stray commit message and a wrong version number is this.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bumpFrom,
  changelogSection,
  nextVersion,
  parseCommits,
  prependSection,
} from '../scripts/release.mjs';

const log = (...commits) => commits.map((c) => '\u0000' + c).join('\n');

test('a commit is read as Conventional Commits, body and all', () => {
  const [c] = parseCommits(log('fix(adopt)!: stop moving name-only matches\n\nBREAKING CHANGE: --loose is now required.'));
  assert.equal(c.type, 'fix');
  assert.equal(c.scope, 'adopt');
  assert.equal(c.subject, 'stop moving name-only matches');
  assert.equal(c.breaking, true);

  // A subject that follows no convention is still a commit — it just does not
  // earn a release on its own.
  const [plain] = parseCommits(log('tidy up the readme'));
  assert.equal(plain.type, null);
  assert.equal(plain.subject, 'tidy up the readme');

  // A body with blank lines in it is one commit, not three.
  assert.equal(parseCommits(log('fix: a\n\nline\n\nline')).length, 1);
});

test('the highest bump any commit asks for is the one taken', () => {
  assert.equal(bumpFrom(parseCommits(log('docs: readme', 'chore: deps'))), 'none');
  assert.equal(bumpFrom(parseCommits(log('fix: one', 'docs: two'))), 'patch');
  assert.equal(bumpFrom(parseCommits(log('fix: one', 'feat: two'))), 'minor');
  assert.equal(bumpFrom(parseCommits(log('feat!: one', 'fix: two'))), 'major');
});

test('below 1.0.0 a breaking change moves the minor, not the major', () => {
  // Declaring the tool stable is a decision, not something one `feat!:` gets to
  // make on the author's behalf.
  assert.equal(nextVersion('0.2.1', 'major'), '0.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('0.2.1', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.2.1', 'patch'), '0.2.2');
  assert.equal(nextVersion('0.2.1', 'none'), null);
});

test('the changelog section groups the commits and keeps the scope', () => {
  const section = changelogSection(
    '0.3.0',
    '2026-01-01',
    parseCommits(log('feat(sync): parallel fetch', 'fix: a crash', 'chore: bump ci')),
  );
  assert.match(section, /^## \[0\.3\.0\] - 2026-01-01$/m);
  assert.match(section, /### Added\n- \*\*sync\*\*: parallel fetch/);
  assert.match(section, /### Fixed\n- a crash/);
  assert.match(section, /### Chores\n- bump ci/);
  // An empty group is left out rather than printed empty.
  assert.doesNotMatch(section, /### Documentation/);
});

test('a new section goes above every old one and changes none of them', () => {
  const before = '# Changelog\n\nblurb\n\n## [0.1.0] - 2020-01-01\n\n### Added\n- the tool\n';
  const after = prependSection(before, '## [0.2.0] - 2020-02-02\n\n### Fixed\n- a bug\n');
  assert.ok(after.indexOf('## [0.2.0]') < after.indexOf('## [0.1.0]'), 'new section is not first');
  assert.ok(after.startsWith('# Changelog\n\nblurb'), 'the header was disturbed');
  assert.match(after, /## \[0\.1\.0\] - 2020-01-01\n\n### Added\n- the tool/);
});
