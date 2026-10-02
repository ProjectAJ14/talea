import { spawn } from 'node:child_process';
import path from 'node:path';

import { repoLabel } from '../config.js';
import { c, fail, heading, info, ok, plain, summary } from '../log.js';
import { clonedOnly, machineRepos, requireWorkspace, selectRepos, withPaths } from '../workspace.js';
import { task } from '../live.js';

export const help = `
${c.bold('talea exec')} — run one command in every repo

  ${c.dim('talea exec -- git log --oneline -1')}
  ${c.dim("talea exec -g nonstopio --shell -- 'npm install'")}
  ${c.dim('talea exec -- git commit -m "two words"')}
  ${c.dim("talea exec --shell -- 'yarn build && yarn test'")}

Everything after ${c.bold('--')} is the command. It runs once per repo with the
repo as the working directory, and each argument arrives exactly as your shell
handed it over — spaces, quotes, an empty one, a ${c.dim('$')} or a ${c.dim(';')} included. No second
shell reads it.

${c.bold('--shell')} hands the words to your system shell instead (sh, or cmd.exe on Windows),
joined with spaces, and that shell splits and interprets them again: pipes,
${c.dim('&&')}, globs and variables work, and quoting is that shell's. Quote the whole
thing once so your own shell passes it through untouched, as above.

On Windows, ${c.dim('npm')}, ${c.dim('yarn')} and other ${c.dim('.cmd')} scripts only run through cmd.exe — use
${c.bold('--shell')} for them.

Options
  -g, --group <names>   comma-separated groups
  -r, --repo <names>    repo names or owner/name, comma-separated
      --all             every repo in the catalogue, not just what this machine keeps —
                        never one marked ignore: true
      --shell           run the command through the system shell

Repos are processed one at a time so the output stays readable and attributable.
`;

/** An argument as it would have to be typed, so the heading shows its boundaries. */
const shown = (arg) => (arg === '' || /[\s"'\\$`]/.test(arg) ? JSON.stringify(arg) : arg);

export function runOne(command, args, cwd, { shell = false } = {}) {
  return new Promise((resolve) => {
    // No shell unless asked: joined into one string and re-split by sh, "two
    // words" arrived as two arguments and a literal `;` ran a second command
    // (found in review). Without one, argv goes to the program as it is.
    const stdio = ['ignore', 'pipe', 'pipe'];
    // Windows starts a .cmd or .bat script only through cmd.exe, so without a
    // shell `npm` is "not found" (ENOENT) and `npm.cmd` is refused (EINVAL).
    // Said, rather than run through cmd.exe quietly — which would re-split
    // every argument. No ready-made line: one built here would re-split them
    // too (found in review), and the cause may be a typo or a missing folder.
    const failed = (e) => {
      const hint =
        process.platform === 'win32' && !shell && ['ENOENT', 'EINVAL'].includes(e.code)
          ? ' — if it is a .cmd or .bat script, such as npm, run it with --shell, where cmd.exe reads the line'
          : '';
      resolve({ code: -1, out: e.message + hint });
    };
    let child;
    try {
      child = shell
        ? spawn([command, ...args].join(' '), { cwd, shell: true, stdio })
        : spawn(command, args, { cwd, shell: false, stdio });
    } catch (e) {
      // Some refusals are thrown, not emitted — EINVAL for a .cmd among them —
      // and one uncaught here stopped the whole run at the first repo.
      failed(e);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', failed);
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

  const line = opts.shell ? [command, ...args].join(' ') : [command, ...args].map(shown).join(' ');
  heading(`${c.bold(line)} ${c.dim(`in ${entries.length} repos${opts.shell ? ', through the shell' : ''}`)}`);

  const counts = { ok: 0, skipped: 0, failed: 0, okLabel: 'ok' };

  for (const { repo, dir } of entries) {
    const name = repoLabel(manifest, repo);
    const res = await task(`${name}  ${c.dim(line)}`, () => runOne(command, args, dir, { shell: opts.shell }));
    const label = `${c.bold(name)} ${c.dim(path.relative(root, dir))}`;
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
