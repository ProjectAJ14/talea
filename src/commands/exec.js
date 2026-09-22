import { spawn } from 'node:child_process';
import path from 'node:path';

import { c, fail, heading, info, ok, plain, summary } from '../log.js';
import { clonedOnly, machineRepos, requireWorkspace, selectRepos, withPaths } from '../workspace.js';

export const help = `
${c.bold('talea exec')} — run one command in every repo

  ${c.dim('talea exec -- git log --oneline -1')}
  ${c.dim('talea exec -g nonstopio -- npm install')}
  ${c.dim('talea exec -- git branch --show-current')}

Everything after ${c.bold('--')} is the command. It runs once per repo with the
repo as the working directory.

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    comma-separated repo names
      --all             every repo in the catalogue, not just what this machine keeps

Repos are processed one at a time so the output stays readable and attributable.
`;

function runOne(command, args, cwd) {
  return new Promise((resolve) => {
    // shell:true so developers can write `talea exec -- yarn build && yarn test`
    // and get the shell semantics they expect on their own platform.
    const child = spawn([command, ...args].join(' '), {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
    child.on('close', (code) => resolve({ code, out: out.trimEnd() }));
  });
}

export async function run(opts, positionals) {
  const [command, ...args] = positionals;
  if (!command) {
    fail('Nothing to run. Put the command after `--`, e.g. `talea exec -- git status`.');
    process.exit(1);
  }

  const { root, manifest, state } = await requireWorkspace();
  const pool = opts.all ? manifest.repos : machineRepos(manifest, state);
  const entries = clonedOnly(withPaths(manifest, root, selectRepos(manifest, opts, pool)));

  heading(`${c.bold([command, ...args].join(' '))} ${c.dim(`in ${entries.length} repos`)}`);

  const counts = { ok: 0, skipped: 0, failed: 0, okLabel: 'ok' };

  for (const { repo, dir } of entries) {
    const res = await runOne(command, args, dir);
    const label = `${c.bold(repo.name)} ${c.dim(path.relative(root, dir))}`;
    if (res.code === 0) {
      counts.ok++;
      ok(label);
    } else {
      counts.failed++;
      fail(`${label} ${c.dim(`(exit ${res.code})`)}`);
    }
    if (res.out) {
      plain(
        res.out
          .split('\n')
          .map((l) => '    ' + c.dim(l))
          .join('\n'),
      );
    }
  }

  summary(counts);
}
