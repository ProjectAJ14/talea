// The catalogue's trip between machines.
//
// A private gist, and nothing else: no server to run, no account to create, no
// extra repo to remember to commit. It is reachable with the token the machine
// already has for `discover`, it has a URL you can paste into the next laptop,
// and it keeps a revision history for free.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  MANIFEST_NAME,
  USER_MANIFEST,
  findWorkspace,
  loadManifest,
  readUserState,
  writeUserState,
} from '../config.js';
import { createGist, readGist, token, updateGist } from '../github.js';
import { c, context, fail, heading, info, ok, plain, warn } from '../log.js';

export const help = `
${c.bold('talea manifest')} — move the catalogue between machines

  ${c.dim('talea manifest push')}              publish it to a private gist
  ${c.dim('talea manifest pull')}              fetch the one this machine is linked to
  ${c.dim('talea manifest pull <gist-id>')}    link this machine to a gist and fetch it
  ${c.dim('talea manifest where')}             which file is in use, and which gist

The catalogue is the only thing that travels. What each machine *keeps* stays
in that machine's ${c.dim('.talea.json')} and is never published — so pulling on a new
laptop gives you the full list to choose from, not the last machine's choices.

The gist is ${c.bold('private')}. It still holds the names of your private repositories,
so treat the id like a bookmark you would not paste into a public channel.

The id is remembered in ${c.dim('~/.talea/state.json')}, so after the first ${c.dim('pull <id>')}
every later ${c.dim('push')} and ${c.dim('pull')} needs no argument.

Options
      --gist <id>       use this gist for one command without remembering it
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

async function push(opts) {
  const { tok, from } = requireToken();
  const { manifest, file } = currentFile();

  if (!manifest.repos.length) {
    fail('The catalogue is empty — there is nothing to publish.');
    console.error('\n  Run `talea discover --apply` first.');
    process.exit(1);
  }

  const state = readUserState();
  const id = opts.gist ?? state.gist ?? null;

  // Published from the file on disk, byte for byte, rather than from the parsed
  // object — a round trip through JSON.parse would drop comments-by-convention,
  // key order and anything a future version of the format adds that this
  // version does not know to keep.
  const content = readFileSync(file, 'utf8');

  heading(id ? 'Updating the catalogue gist' : 'Publishing the catalogue');
  context([
    ['auth', c.dim(from)],
    ['from', c.dim(file)],
    ['repos', `${manifest.repos.length}`],
  ]);

  const gistId = id
    ? await updateGist({ token: tok, id, filename: GIST_FILE, content })
    : await createGist({
        token: tok,
        filename: GIST_FILE,
        content,
        description: 'talea catalogue — the repos I keep, and where they go',
      });

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

  const content = await readGist({ token: tok, id, filename: GIST_FILE });

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
  if (!Array.isArray(parsed.repos)) {
    fail('That gist has no `repos` array, so it is not a talea catalogue.');
    process.exit(1);
  }

  mkdirSync(path.dirname(USER_MANIFEST), { recursive: true });
  writeFileSync(USER_MANIFEST, content.endsWith('\n') ? content : content + '\n');
  writeUserState({ ...state, gist: id });

  plain('');
  ok(`${parsed.repos.length} repos ${c.dim(`→ ${USER_MANIFEST}`)}`);

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
