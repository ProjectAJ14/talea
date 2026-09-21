// Decide the next release from the commits, and write the two files that carry
// it: `package.json` and `CHANGELOG.md`.
//
// This runs in CI, on every push to main. Nothing about a release happens on a
// laptop — not the bump, not the tag, not the notes — because a release cut on
// whichever machine you were sitting at is a release nobody else can reproduce.
//
// The commits are the input, so they have to mean something: Conventional
// Commits (`feat:`, `fix:`, `fix(adopt)!:`) decide the version. A push whose
// commits are all docs and chores releases nothing, which is the point — most
// pushes should not ship a version.
//
// The decision lives in exported functions rather than inline in the workflow
// so a test can drive it. `test/release.test.js` is that test.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

/** Conventional Commits: `type(scope)!: subject`. */
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<subject>.+)$/;

// A commit is a record separator followed by the subject and the body, so a
// body that itself contains blank lines cannot be mistaken for a new commit.
const SEP = '\u0000';

/** Split `git log --format=%x00%s%n%b` output into `{ type, subject, body }`. */
export function parseCommits(log) {
  return log
    .split(SEP)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const [header, ...rest] = raw.split('\n');
      const m = HEADER.exec(header.trim());
      return {
        header: header.trim(),
        type: m?.groups.type ?? null,
        scope: m?.groups.scope ?? null,
        subject: m?.groups.subject ?? header.trim(),
        breaking: Boolean(m?.groups.bang) || /^BREAKING[ -]CHANGE:/m.test(rest.join('\n')),
      };
    });
}

const BUMPS = { major: 3, minor: 2, patch: 1, none: 0 };

/** The bump these commits ask for: major | minor | patch | none. */
export function bumpFrom(commits) {
  let level = 'none';
  const raise = (next) => {
    if (BUMPS[next] > BUMPS[level]) level = next;
  };
  for (const c of commits) {
    if (c.breaking) raise('major');
    else if (c.type === 'feat') raise('minor');
    else if (c.type === 'fix' || c.type === 'perf') raise('patch');
  }
  return level;
}

/**
 * Apply a bump to a version.
 *
 * Below 1.0.0 a breaking change moves the minor, not the major. One `feat!:`
 * should not declare the tool stable on the author's behalf — going 1.0.0 is a
 * statement about the API, and it stays a deliberate act.
 */
export function nextVersion(current, level) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (level === 'none') return null;
  if (level === 'major') return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const GROUPS = [
  ['Added', ['feat']],
  ['Fixed', ['fix']],
  ['Changed', ['refactor', 'perf', 'style']],
  ['Documentation', ['docs']],
  ['Chores', ['chore', 'ci', 'build', 'test']],
];

/** The CHANGELOG section for one release, ready to prepend and to release with. */
export function changelogSection(version, date, commits) {
  const lines = [`## [${version}] - ${date}`];
  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length) {
    lines.push('', '### Breaking');
    for (const c of breaking) lines.push(`- ${c.subject}`);
  }
  for (const [title, types] of GROUPS) {
    const mine = commits.filter((c) => types.includes(c.type) && !c.breaking);
    if (!mine.length) continue;
    lines.push('', `### ${title}`);
    for (const c of mine) lines.push(`- ${c.scope ? `**${c.scope}**: ` : ''}${c.subject}`);
  }
  return lines.join('\n') + '\n';
}

/** Prepend a section under the file's header, never touching what is below it. */
export function prependSection(changelog, section) {
  const at = changelog.search(/^## /m);
  return at === -1
    ? changelog.trimEnd() + '\n\n' + section
    : changelog.slice(0, at) + section + '\n' + changelog.slice(at);
}

// ── the CI half ────────────────────────────────────────────────

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function main() {
  const forced = process.argv[2] && process.argv[2] !== 'auto' ? process.argv[2] : null;

  let lastTag = null;
  try {
    lastTag = git('describe', '--tags', '--abbrev=0');
  } catch {
    // No tag yet: everything in the history is this release.
  }

  const log = git(
    'log',
    ...(lastTag ? [`${lastTag}..HEAD`] : []),
    '--no-merges',
    // `%x00` is git's own escape for the separator — a literal NUL cannot be
    // passed through argv, which rejects one outright.
    '--format=%x00%s%n%b',
  );
  const commits = parseCommits(log);
  const level = forced ?? bumpFrom(commits);

  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = nextVersion(pkg.version, level);

  if (!version) {
    console.log(`nothing to release — ${commits.length} commit(s) since ${lastTag ?? 'the start'}`);
    output('release', 'false');
    return;
  }

  const section = changelogSection(version, new Date().toISOString().slice(0, 10), commits);
  const changelogPath = new URL('../CHANGELOG.md', import.meta.url);
  writeFileSync(changelogPath, prependSection(readFileSync(changelogPath, 'utf8'), section));

  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // The notes go to a file: a multi-line value through $GITHUB_OUTPUT needs a
  // heredoc delimiter that the notes themselves must not contain, and release
  // notes are exactly the text that would eventually contain it.
  writeFileSync(new URL('../.release-notes.md', import.meta.url), section);

  console.log(`${pkg.name} ${version} (${level}, ${commits.length} commit(s))`);
  output('release', 'true');
  output('version', version);
}

const output = (key, value) => {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

// Only when run as a script — the test imports the functions above.
if (process.argv[1] && process.argv[1].endsWith('release.mjs')) main();
