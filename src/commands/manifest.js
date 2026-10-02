// The catalogue's trip between machines.
//
// A secret gist, and nothing else: no server to run, no account to create, no
// extra repo to remember to commit. It is reachable with the token the machine
// already has for `discover`, it has a URL you can paste into the next laptop,
// and it keeps a revision history for free.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  MANIFEST_NAME,
  USER_MANIFEST,
  catalogueProblems,
  folderClashes,
  findWorkspace,
  loadManifest,
  readUserState,
  writeUserState,
} from '../config.js';
import { createGist, readGist, token, updateGist } from '../github.js';
import { c, context, fail, heading, info, ok, plain, warn } from '../log.js';
import { task } from '../live.js';

export const help = `
${c.bold('talea manifest')} — move the catalogue between machines

  ${c.dim('talea manifest push')}              publish it to a secret gist
  ${c.dim('talea manifest push --new')}        a new secret gist, not the remembered one
  ${c.dim('talea manifest pull')}              fetch the one this machine is linked to
  ${c.dim('talea manifest pull <gist-id>')}    link this machine to a gist and fetch it
  ${c.dim('talea manifest where')}             which file is in use, and which gist

The catalogue is the only thing that travels. What each machine *keeps* stays
in that machine's ${c.dim('.talea.json')} and is never published — so pulling on a new
laptop gives you the full list to choose from, not the last machine's choices.

The gist is ${c.bold('secret')}, which GitHub means as unlisted, not private: anyone who
has its URL or id can read it, every revision included, without signing in. It
holds the names of your private repositories, so treat the id like a password-reset
link. push reads an existing gist's visibility first and refuses a public one
before sending anything, and refuses a catalogue with a password or token in a URL.

Pushed to a public gist once? Its repo names are public in every revision: delete
that gist on gist.github.com (forks and copies survive), then ${c.dim('push --new')}. A
token pushed even to a secret gist stays in its revisions (the Revisions tab on
the gist's page shows them): revoke the token, delete the gist, and push --new.

The id is remembered in ${c.dim('~/.talea/state.json')}, so after the first ${c.dim('pull <id>')}
every later ${c.dim('push')} and ${c.dim('pull')} needs no argument.

A pulled catalogue is checked before it is written: every folder it names must
be below the workspace, and no two repos may share one. One that fails is
refused with each problem named, and your current catalogue is left as it was.

Options
      --gist <id>       use this gist, and remember it for the next push and pull
      --new             push to a new secret gist instead of the remembered one
`;

const GIST_FILE = MANIFEST_NAME;

function requireToken() {
  const { token: tok, from } = token();
  if (!tok) {
    fail('A GitHub token is needed to read or write a gist.');
    console.error('\n  Run `gh auth login`, or set GITHUB_TOKEN.');
    process.exit(1);
  }
  return { tok, from };
}

/** The catalogue file this machine would load, and where it came from. */
function currentFile() {
  const root = findWorkspace();
  const manifest = loadManifest(root);
  return { root, manifest, file: manifest.__source };
}

// A URL's user part: `scheme://<user>[:<password>]@host`.
const USERINFO = /[a-z][a-z0-9+.-]*:\/\/([^/@\s"'\\]+)@/gi;
// What a token looks like when it is the whole user part: GitHub's and
// GitLab's prefixes, or a long run of token characters. `alice` in Bitbucket's
// `https://alice@bitbucket.org/…` is a username, and is not one.
const TOKEN = /^(gh[pousr]_|github_pat_|glpat-|x-access-token$|oauth2$)|^[A-Za-z0-9_-]{30,}$/;

/**
 * Every line of the catalogue file with a secret in a URL, the secret masked.
 * Read off the raw text, because that is what push uploads: a duplicate key
 * or a field talea does not read survives the upload but not JSON.parse
 * (found in review). A password (`user:pass@`) on any scheme is a secret, and
 * so is a user part that looks like a token; `git@host:` and `ssh://git@host`
 * carry neither. The rest of a catalogue is repo names, owners, folders and
 * branches — private repo names are why the gist is secret, and nothing in it
 * should need to be more than that.
 */
export function credentialsIn(content) {
  const found = [];
  content.split('\n').forEach((line, i) => {
    for (const [url, user] of line.matchAll(USERINFO)) {
      const [name] = user.split(':');
      if (user.includes(':') || TOKEN.test(name)) found.push(`line ${i + 1}: ${url.replace(user, '***')}…`);
    }
  });
  return found;
}

async function push(opts) {
  const { tok, from } = requireToken();
  const { manifest, file } = currentFile();

  if (!manifest.repos.length) {
    fail('The catalogue is empty — there is nothing to publish.');
    console.error('\n  Run `talea discover --apply` first.');
    process.exit(1);
  }

  // --new is a gist of its own; naming another one too is two answers.
  if (opts.new && opts.gist) {
    fail('--new publishes to a new gist, and --gist names an existing one — pick one.');
    process.exit(1);
  }

  const state = readUserState();
  // --new: a fresh secret gist, the way out once the remembered one is public.
  const id = opts.new ? null : (opts.gist ?? state.gist ?? null);

  // Published from the file on disk, byte for byte, rather than from the parsed
  // object — a round trip through JSON.parse would drop comments-by-convention,
  // key order and anything a future version of the format adds that this
  // version does not know to keep.
  const content = readFileSync(file, 'utf8');

  // Nothing in the catalogue should be a secret; a credential written into a
  // URL would be, and push would carry it to a gist anyone with the link reads.
  const leaks = credentialsIn(content);
  if (leaks.length) {
    fail(`${file} holds a credential in a URL, so it was not uploaded:`);
    for (const where of leaks) console.error(`    - ${where}`);
    console.error('\n  Take the password or token out of the URL — git reads it from your credential helper or SSH key.');
    console.error('  If it was pushed before, it is in the gist\'s revisions: revoke that token, delete the gist, and push --new.');
    process.exit(1);
  }

  heading(id ? 'Updating the catalogue gist' : 'Publishing the catalogue');
  context([
    ['auth', c.dim(from)],
    ['from', c.dim(file)],
    ['repos', `${manifest.repos.length}`],
  ]);

  let gistId;
  try {
    gistId = await task('Uploading to GitHub', () =>
      id
        ? updateGist({ token: tok, id, filename: GIST_FILE, content })
        : createGist({
            token: tok,
            filename: GIST_FILE,
            content,
            description: 'talea catalogue — the repos I keep, and where they go',
          }),
    );
  } catch (err) {
    if (err.code !== 'PUBLIC_GIST') throw err;
    fail(err.message);
    console.error('\n  A public gist cannot be made secret. Push to a new secret one instead:');
    console.error(`    talea manifest push --new`);
    console.error('  If the catalogue was ever pushed to that gist, its repo names are public, in every revision:');
    console.error(`    delete it at https://gist.github.com/${id} — deleting removes the revisions too, but not forks or copies.`);
    process.exit(1);
  }

  writeUserState({ ...state, gist: gistId });

  plain('');
  ok(`gist ${c.bold(gistId)}`);
  plain(c.dim(`  https://gist.github.com/${gistId}`));
  plain('');
  info(`On another machine: ${c.bold(`talea manifest pull ${gistId}`)}`);
}

async function pull(opts, positionals) {
  const { tok, from } = requireToken();
  const state = readUserState();
  const id = positionals[0] ?? opts.gist ?? state.gist ?? null;

  if (!id) {
    fail('No gist to pull from.');
    console.error('\n  Pass the id once — `talea manifest pull <gist-id>` — and it is remembered.');
    process.exit(1);
  }

  heading('Pulling the catalogue');
  context([
    ['auth', c.dim(from)],
    ['gist', c.bold(id)],
  ]);

  const content = await task('Downloading from GitHub', () => readGist({ token: tok, id, filename: GIST_FILE }));

  // Parsed before it is written, never after: a truncated download or somebody
  // else's gist would otherwise land on top of a working catalogue and only
  // fail on the next command, with the good copy already gone.
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    fail(`That gist is not a catalogue — ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed?.repos)) {
    fail('That gist has no `repos` array, so it is not a talea catalogue.');
    process.exit(1);
  }
  // Every field, the same check a load makes: written first and checked on
  // the next command, a bad one would already have replaced the good copy.
  const problems = catalogueProblems(parsed);
  if (problems.length) {
    fail(`That gist is not a usable catalogue, so ${USER_MANIFEST} was left as it was:`);
    for (const p of problems.slice(0, 10)) console.error(`    - ${p}`);
    if (problems.length > 10) console.error(`    … and ${problems.length - 10} more`);
    console.error('\n  Fix the catalogue where it was pushed from, then pull again.');
    process.exit(1);
  }

  mkdirSync(path.dirname(USER_MANIFEST), { recursive: true });
  writeFileSync(USER_MANIFEST, content.endsWith('\n') ? content : content + '\n');
  writeUserState({ ...state, gist: id });

  plain('');
  ok(`${parsed.repos.length} repos ${c.dim(`→ ${USER_MANIFEST}`)}`);
  // Not a reason to refuse: sync names them again, and stops, before placing either.
  for (const clash of folderClashes(parsed)) warn(clash);

  const { file } = currentFile();
  if (file !== USER_MANIFEST) {
    warn(`A nearer catalogue is still winning: ${c.bold(file)}`);
    plain(c.dim('  Delete or rename it if you meant to use the one you just pulled.'));
    return;
  }

  plain('');
  info(`Next: ${c.bold('talea init ~/Workspace')} — or ${c.bold('talea sync --pick')} if you already have one.`);
}

function where() {
  const { root, manifest, file } = currentFile();
  const { gist } = readUserState();

  heading('Catalogue');
  context([
    ['in use', c.bold(file)],
    ['repos', `${manifest.repos.length}`],
  ]);
  plain('');
  plain(`  ${c.dim('workspace')}  ${root ?? c.dim('none found')}`);
  plain(`  ${c.dim('gist')}       ${gist ? `${gist}  ${c.dim(`https://gist.github.com/${gist}`)}` : c.dim('not linked')}`);
  plain(`  ${c.dim('user copy')}  ${USER_MANIFEST}`);
}

export async function run(opts, positionals = []) {
  const [verb, ...rest] = positionals;

  switch (verb) {
    case 'push':
      return push(opts);
    case 'pull':
      return pull(opts, rest);
    case 'where':
    case undefined:
      return where();
    default:
      fail(`Unknown: talea manifest ${verb}`);
      console.error('\n  Try: push, pull, where');
      process.exit(1);
  }
}
