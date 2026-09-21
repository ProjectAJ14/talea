import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { c, fail, plain } from './log.js';

import * as init from './commands/init.js';
import * as discover from './commands/discover.js';
import * as clone from './commands/clone.js';
import * as adopt from './commands/adopt.js';
import * as sync from './commands/sync.js';
import * as status from './commands/status.js';
import * as list from './commands/list.js';
import * as tree from './commands/tree.js';
import * as where from './commands/where.js';
import * as add from './commands/add.js';
import * as manifest from './commands/manifest.js';
import * as doctor from './commands/doctor.js';
import * as exec from './commands/exec.js';
import * as upgrade from './commands/upgrade.js';
import { notifyIfOutdatedAsync } from './update.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const COMMANDS = {
  init,
  discover,
  clone,
  adopt,
  sync,
  status,
  list,
  tree,
  where,
  add,
  rm: add,
  manifest,
  doctor,
  exec,
  upgrade,
};

// Aliases keep the muscle memory people already have from git and from every
// other tool that does one of these jobs.
const ALIASES = {
  setup: 'init',
  bootstrap: 'init',
  pull: 'sync',
  update: 'sync',
  refresh: 'discover',
  ls: 'list',
  st: 'status',
  cd: 'where',
  path: 'where',
  run: 'exec',
  remove: 'rm',
  'self-update': 'upgrade',
};

const OPTIONS = {
  group: { type: 'string', short: 'g', multiple: true },
  repo: { type: 'string', short: 'r', multiple: true },
  jobs: { type: 'string', short: 'j' },
  protocol: { type: 'string' },
  from: { type: 'string', multiple: true },
  user: { type: 'string' },
  since: { type: 'string' },
  gist: { type: 'string' },
  apply: { type: 'boolean', default: false },
  'fix-paths': { type: 'boolean', default: false },
  // parseArgs has no --no-x negation, so the negative flags are declared
  // explicitly and inverted below.
  'no-adopt': { type: 'boolean', default: false },
  'no-clone': { type: 'boolean', default: false },
  'no-archived': { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  on: { type: 'boolean', default: false },
  off: { type: 'boolean', default: false },
  pick: { type: 'boolean', default: false },
  drift: { type: 'boolean', default: false },
  missing: { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  groups: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const USAGE = `
${c.bold('talea')} ${c.dim(`v${pkg.version}`)} — one folder structure for every machine

${c.bold('Usage')}
  talea <command> [options]

${c.bold('Commands')}
  ${c.cyan('init')}       create the workspace on this machine and fill it
  ${c.cyan('discover')}   build the catalogue from your GitHub account
  ${c.cyan('sync')}       clone what is missing, fast-forward what is there
  ${c.cyan('clone')}      clone only — never fetches or merges
  ${c.cyan('adopt')}      move repos you already have into the right place
  ${c.cyan('status')}     one table: branch, clean/dirty, ahead/behind
  ${c.cyan('add')}        keep another repo on this machine (${c.dim('rm')} to drop one)
  ${c.cyan('where')}      print a repo's path — ${c.dim('cd $(talea where eklavya)')}
  ${c.cyan('list')}       show the catalogue
  ${c.cyan('tree')}       the folder tree on disk
  ${c.cyan('exec')}       run one command in every repo
  ${c.cyan('manifest')}   push or pull the catalogue through a private gist
  ${c.cyan('doctor')}     check git, SSH, GitHub auth and workspace health
  ${c.cyan('upgrade')}    update the CLI itself

${c.bold('A new machine')}
  talea doctor                  ${c.dim('# confirm git and GitHub work first')}
  talea manifest pull <id>      ${c.dim('# your catalogue, from the gist')}
  talea init ~/Workspace        ${c.dim('# pick what this machine keeps, then fill it')}

${c.bold('The first machine')}
  talea init ~/Workspace        ${c.dim('# discovers your repos if the catalogue is empty')}
  talea manifest push           ${c.dim('# publish it so the next machine can read it')}

${c.bold('Every day')}
  talea sync                    ${c.dim('# clone the new, fast-forward the rest')}
  talea status --drift          ${c.dim('# what is not where I left it')}

${c.bold('Common options')}
  -g, --group <names>   restrict to groups, e.g. -g nonstopio
  -r, --repo <names>    restrict to repos, e.g. -r eklavya
  -j, --jobs <n>        how many git operations run at once (default: 6-12)
  -h, --help            help for any command: talea <command> --help
`;

export async function main(argv) {
  // Split on `--` so `talea exec -- git log` passes the tail through verbatim
  // instead of parseArgs trying to interpret git's own flags.
  const sepIndex = argv.indexOf('--');
  const head = sepIndex === -1 ? argv : argv.slice(0, sepIndex);
  const tail = sepIndex === -1 ? [] : argv.slice(sepIndex + 1);

  let parsed;
  try {
    parsed = parseArgs({ args: head, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    fail(err.message);
    plain(c.dim('\nRun `talea --help` for usage.'));
    process.exit(1);
  }

  const { values, positionals } = parsed;

  if (values.version) {
    console.log(pkg.version);
    return;
  }

  const name = positionals[0];
  if (!name) {
    console.log(USAGE);
    return;
  }

  const key = ALIASES[name] ?? name;
  const command = COMMANDS[key];

  if (!command) {
    fail(`Unknown command "${name}".`);
    plain(`\n  Available: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(1);
  }

  if (values.help) {
    console.log(command.help);
    return;
  }

  // `talea sync all` — "all" is how people say it and it is already the
  // default, so accept it as a no-op rather than an error.
  const rest = positionals.slice(1).filter((p) => !(p === 'all' && key !== 'exec'));

  // -j reaches `pooled()` as a worker count. `Math.min(NaN, n)` is NaN, so a
  // non-numeric value silently started zero workers and the command reported
  // success having done nothing at all.
  let jobs;
  if (values.jobs !== undefined) {
    jobs = Number(values.jobs);
    if (!Number.isInteger(jobs) || jobs < 1) {
      fail(`--jobs must be a positive whole number, got "${values.jobs}".`);
      process.exit(1);
    }
  }

  const opts = {
    ...values,
    jobs,
    // `rm` is `add` with the sign flipped; the command reads this rather than
    // being a near-copy of the same forty lines.
    removing: key === 'rm' || name === 'rm' || name === 'remove',
    clone: !values['no-clone'],
    adopt: !values['no-adopt'],
    archived: !values['no-archived'],
    // -g/-r are `multiple`, so they arrive as arrays; leave them for
    // selectRepos to flatten, but normalise "not passed" to undefined.
    group: values.group?.length ? values.group : undefined,
    from: values.from?.length ? values.from : undefined,
    repo: values.repo?.length ? values.repo : undefined,
  };

  await command.run(opts, key === 'exec' ? tail : rest);

  // After the real work, never before it, and never able to fail it.
  if (key !== 'upgrade') {
    try {
      await notifyIfOutdatedAsync();
    } catch {
      // An update check is not worth a non-zero exit.
    }
  }
}
